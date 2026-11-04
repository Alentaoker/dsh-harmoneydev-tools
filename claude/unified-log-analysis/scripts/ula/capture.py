"""One source read for snapshot, SHA256 and streaming encoding validation."""
import codecs,hashlib,re,os,uuid
from pathlib import Path
from .snapshot import Writer,BLOCK

INVALID=re.compile('[\udc80-\udcff]')
NONASCII=re.compile('[^\x00-\x7f\udc80-\udcff]')


def _capture_once(source,target):
    source=Path(source);target=Path(target);before=source.stat();hasher=hashlib.sha256();stored_hash=hashlib.sha256()
    if source.resolve()==target.resolve():
        raise ValueError('工作副本不能覆盖输入文件')
    invalid=valid=raw_size=0;gb_ok=True;bom=None
    utf=codecs.getincrementaldecoder('utf-8-sig')(errors='surrogateescape')
    gb=codecs.getincrementaldecoder('gb18030')(errors='strict')
    copied=Writer(target,stored_hash)
    try:
      with source.open('rb') as original:
        pending=b'';prefix=b'';encoding_pending=b'';detected=False
        while True:
            chunk=original.read(min(BLOCK,max(0,before.st_size-raw_size)))
            prefix=(prefix+chunk)[:4]
            if chunk:
                pending+=chunk;hasher.update(chunk);raw_size+=len(chunk)
                while len(pending)>=BLOCK:
                    copied.write(pending[:BLOCK]);pending=pending[BLOCK:]
            decode_chunk=chunk
            if not detected:
                encoding_pending+=chunk
                if len(prefix)<4 and chunk: continue
                detected=True;decode_chunk=encoding_pending
                bom='utf-16-le' if prefix.startswith(b'\xff\xfe') else 'utf-16-be' if prefix.startswith(b'\xfe\xff') else None
            if not bom:
                text=utf.decode(decode_chunk,final=not chunk);invalid+=len(INVALID.findall(text));valid+=len(NONASCII.findall(text))
                if gb_ok:
                    try:
                        gb.decode(decode_chunk,final=not chunk)
                    except UnicodeError:
                        gb_ok=False
            if not chunk:
                if pending:
                    copied.write(pending)
                break
    finally:
        copied.close()
    after=source.stat();digest=hasher.hexdigest()
    stable=before.st_size==after.st_size and before.st_mtime_ns==after.st_mtime_ns and raw_size==after.st_size
    if before.st_size==after.st_size and before.st_mtime_ns==after.st_mtime_ns and raw_size!=before.st_size:
        raise ValueError('读取不完整，未检测到源文件变化')
    if bom:
        info=dict(encoding=bom,invalidBytes=0,confidence='bom')
    elif not invalid:
        info=dict(encoding='utf-8-sig',invalidBytes=0,confidence='high')
    elif valid>invalid:
        info=dict(encoding='utf-8',invalidBytes=invalid,confidence='high_with_damage')
    elif gb_ok:
        info=dict(encoding='gb18030',invalidBytes=0,utf8InvalidBytes=invalid,confidence='medium')
    else:
        info=dict(encoding='utf-8',invalidBytes=invalid,confidence='low')
    info.update(sha256=digest,snapshotSha256=stored_hash.hexdigest(),snapshotCodec='ula-block-zlib/1',snapshotRawBytes=raw_size,stable=stable,captureStatBefore=dict(size=before.st_size,mtimeNs=before.st_mtime_ns),captureStatAfter=dict(size=after.st_size,mtimeNs=after.st_mtime_ns),readPasses=dict(source=1,snapshotParse=1),captureMethod='source once: lossless compressed copy+raw/stored hashes+encoding; snapshot once: parse')
    return info


def snapshot(source,target):
    target=Path(target)
    first=_capture_once(source,target)
    if first['stable']:
        first['captureAttempts']=1;return first
    retry=target.with_name(target.name+'.retry-'+uuid.uuid4().hex)
    try:
        second=_capture_once(source,retry)
        os.replace(retry,target)
        second.update(captureAttempts=2,previousAttempt=dict(stable=False,sha256=first['sha256']),captureMethod='bounded prefix at each observed start size; one retry; raw/stored hashes bind actual bytes')
        second['readPasses']['source']=2
        return second
    finally:
        retry.unlink(missing_ok=True)
