"""Lossless independently compressed blocks with bounded random-access reads."""
import os,struct,zlib,tempfile
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path

MAGIC=b'ULASNP1\0'
TAIL=b'ULAEND1\0'
BLOCK=65536
ENTRY=struct.Struct('<QII')
FOOTER=struct.Struct('<QQ8s')
_READERS=ContextVar('ula_readers',default=None)


@contextmanager
def reader_scope():
    if _READERS.get() is not None:
        yield;return
    readers={};token=_READERS.set(readers)
    try: yield
    finally:
        for _,stream in readers.values(): stream.close()
        _READERS.reset(token)


@contextmanager
def shared_binary(path):
    readers=_READERS.get()
    if readers is None:
        with open_binary(path) as stream: yield stream
        return
    key=str(Path(path).resolve());stat=Path(path).stat();signature=(stat.st_size,stat.st_mtime_ns)
    if key not in readers or readers[key][0]!=signature:
        if key in readers: readers[key][1].close()
        readers[key]=(signature,open_binary(path))
    yield readers[key][1]


class Writer:
    def __init__(self,path,hasher):
        self.path=Path(path);self.stream=self.path.open('xb');self.hasher=hasher
        self.index=tempfile.TemporaryFile(mode='w+b',dir=self.path.parent);self.count=0
        self.emit(MAGIC+struct.pack('<I',BLOCK))

    def emit(self,data):
        self.stream.write(data);self.hasher.update(data)

    def write(self,raw):
        if not raw or len(raw)>BLOCK:
            raise ValueError('无效的快照压缩块')
        data=zlib.compress(raw,1);self.index.write(ENTRY.pack(self.stream.tell(),len(data),len(raw)));self.count+=1;self.emit(data)

    def close(self):
        try:
            offset=self.stream.tell();self.index.seek(0)
            while True:
                data=self.index.read(1024*1024)
                if not data:
                    break
                self.emit(data)
            self.emit(FOOTER.pack(offset,self.count,TAIL))
        finally:
            self.index.close();self.stream.close()


class Reader:
    def __init__(self,path):
        self.stream=Path(path).open('rb');self.position=0;self.cached=-1;self.buffer=b''
        try:
            self.stream.seek(0,os.SEEK_END);length=self.stream.tell()
            if length<12+FOOTER.size:
                raise ValueError('快照不完整')
            self.stream.seek(0);header=self.stream.read(12)
            self.stream.seek(-FOOTER.size,os.SEEK_END);self.index_offset,self.count,tail=FOOTER.unpack(self.stream.read(FOOTER.size))
            if header!=MAGIC+struct.pack('<I',BLOCK) or tail!=TAIL or self.index_offset+self.count*ENTRY.size!=length-FOOTER.size:
                raise ValueError('快照索引无效')
            self.stream.seek(self.index_offset);self.index=self.stream.read(self.count*ENTRY.size)
            if len(self.index)!=self.count*ENTRY.size: raise ValueError('快照索引不完整')
            if self.count:
                expected=12
                for i in range(self.count):
                    offset,size,raw_size=self.entry(i)
                    if offset!=expected or size<=0 or size>BLOCK*2+256 or raw_size<=0 or raw_size>BLOCK or (i<self.count-1 and raw_size!=BLOCK):
                        raise ValueError('快照块长度或连续性无效')
                    expected=offset+size
                if expected!=self.index_offset:
                    raise ValueError('快照索引与数据不连续')
                _,_,last_size=self.entry(self.count-1);self.size=(self.count-1)*BLOCK+last_size
            else:
                if self.index_offset!=12:
                    raise ValueError('空快照数据无效')
                self.size=0
        except Exception:
            self.stream.close();raise

    def entry(self,index):
        return ENTRY.unpack_from(self.index,index*ENTRY.size)

    def block(self,index):
        if self.cached!=index:
            offset,size,raw_size=self.entry(index)
            if size>BLOCK*2+256 or raw_size>BLOCK or raw_size<=0 or offset<12 or offset+size>self.index_offset:
                raise ValueError('快照块越界')
            self.stream.seek(offset);decoder=zlib.decompressobj();raw=decoder.decompress(self.stream.read(size),BLOCK+1)
            if len(raw)!=raw_size or not decoder.eof or decoder.unused_data:
                raise ValueError('快照压缩块损坏或超限')
            self.cached=index;self.buffer=raw
        return self.buffer

    def seek(self,offset,whence=0):
        target=offset if whence==0 else self.position+offset if whence==1 else self.size+offset
        if target<0:
            raise ValueError('负数快照偏移')
        self.position=target;return target

    def tell(self):
        return self.position

    def read(self,size=-1):
        size=max(0,self.size-self.position) if size<0 else min(size,max(0,self.size-self.position));parts=[]
        while size:
            block=self.block(self.position//BLOCK);start=self.position%BLOCK;amount=min(size,len(block)-start)
            if amount<=0:
                raise ValueError('快照长度不一致')
            parts.append(block[start:start+amount]);self.position+=amount;size-=amount
        return b''.join(parts)

    def readline(self):
        parts=[];total=0
        while self.position<self.size:
            data=self.block(self.position//BLOCK);start=self.position%BLOCK;end=data.find(b'\n',start)
            end=len(data) if end<0 else end+1;part=data[start:end];parts.append(part);self.position+=len(part);total+=len(part)
            if not part:
                raise ValueError('快照读取未前进')
            if total>16*1024*1024:
                raise ValueError('单行超过16MiB；请显式转换日志后重新分析，未截断原始输入')
            if part.endswith(b'\n'):
                break
        return b''.join(parts)

    def close(self):
        self.stream.close()

    def __enter__(self):
        return self

    def __exit__(self,*args):
        self.close()


def open_binary(path):
    return Reader(path) if str(path).endswith('.ulz') else open(path,'rb')
