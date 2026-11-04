import bz2
import datetime as dt
import gzip
import hashlib
import json
import lzma
import os
from pathlib import Path
import shutil
import sqlite3
import stat
import sys
import tarfile
import zipfile
from .storage import parse_datetime
from .provenance import execution_identity

ROOT = Path(__file__).resolve().parents[2]
VERSION = '0.2.0-beta.1'


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + '.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    os.replace(temp, path)


def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1024 * 1024), b''):
            h.update(b)
    return h.hexdigest()


def now():
    return dt.datetime.now().astimezone().isoformat(timespec='seconds')


def question(args):
    run=load(args.run)
    if run['queries']:
        raise ValueError('问题原文、类型和时段必须在首次检索前登记；更换问题请新建分析')
    q=run['question']
    if args.question is not None:
        q['raw']=args.question
        if not args.question_type:
            q['type']='triage'
    if args.question_type:
        q['type']=args.question_type
    if args.problem_window:
        start,end=map(parse_datetime,args.problem_window)
        if end<=start:
            raise ValueError('问题时段结束须晚于开始')
        q['problemWindow']=dict(range=args.problem_window,source='user')
    q['registeredAt']=now();run['registeredQuestion']=json.loads(json.dumps(q))
    decision(run,'question',q,'检索前登记分析目标');save(run)
    return dict(ok=True,question=q,next='search')


def inside(path, root):
    path, root = Path(path).resolve(), Path(root).resolve()
    if path == root or root not in path.parents:
        raise ValueError('路径必须严格位于工作区内: ' + str(path))
    return path


def kind(path):
    name = str(path).lower()
    if name.endswith(('.zip', '.tar', '.tgz', '.tar.gz', '.tar.bz2', '.tar.xz', '.gz', '.bz2', '.xz')):
        return 'archive'
    sample = Path(path).open('rb')
    with sample:
        b = sample.read(8192)
    if b.startswith((b'\xff\xfe', b'\xfe\xff')):
        return 'text'
    return 'binary' if b'\x00' in b else 'text'


def encoding(path):
    return encoding_info(path)['encoding']


def encoding_info(path):
    with open(path, 'rb') as f:
        head = f.read(4)
    if head.startswith(b'\xff\xfe'):
        return dict(encoding='utf-16-le',invalidBytes=0,confidence='bom')
    if head.startswith(b'\xfe\xff'):
        return dict(encoding='utf-16-be',invalidBytes=0,confidence='bom')
    # Validate streaming, rather than trusting a sample.
    for enc in ('utf-8-sig',):
        try:
            with open(path, encoding=enc) as f:
                for _ in f:
                    pass
            return dict(encoding=enc,invalidBytes=0,confidence='high')
        except UnicodeError:
            pass
    invalid=nonascii=size=0
    import codecs,re
    dec=codecs.getincrementaldecoder('utf-8-sig')(errors='surrogateescape')
    with open(path,'rb') as f:
        while True:
            chunk=f.read(1024*1024)
            text=dec.decode(chunk,final=not chunk);size+=len(chunk)
            invalid+=len(re.findall('[\udc80-\udcff]',text));nonascii+=len(re.findall('[^\x00-\x7f\udc80-\udcff]',text))
            if not chunk:
                break
    if nonascii>invalid:
        return dict(encoding='utf-8',invalidBytes=invalid,confidence='high_with_damage')
    try:
        with open(path,encoding='gb18030') as f:
            for _ in f:
                pass
        return dict(encoding='gb18030',invalidBytes=0,utf8InvalidBytes=invalid,confidence='medium')
    except UnicodeError:
        return dict(encoding='utf-8',invalidBytes=invalid,confidence='low')


def raw_lines(path, enc):
    """Original byte offsets/hash, including original newline bytes."""
    from .snapshot import open_binary
    if enc.startswith('utf-16'):
        newline=b'\n\x00' if enc.endswith('le') else b'\x00\n';buffer=b'';base=n=0
        with open_binary(path) as f:
            while True:
                chunk=f.read(1024*1024);buffer+=chunk;start=0
                while True:
                    end=buffer.find(newline,start)
                    while end>=0 and end%2:
                        end=buffer.find(newline,end+1)
                    if end<0:
                        break
                    end+=2;raw=buffer[start:end];n+=1
                    if len(raw)>16*1024*1024:
                        raise ValueError('单行超过16MiB；请显式转换日志后重新分析，未截断原始输入')
                    yield n,base+start,raw,raw.decode(enc,errors='replace').lstrip('\ufeff').rstrip('\r\n')
                    start=end
                base+=start;buffer=buffer[start:]
                if len(buffer)>16*1024*1024:
                    raise ValueError('单行超过16MiB；请显式转换日志后重新分析，未截断原始输入')
                if not chunk:
                    if buffer:
                        n+=1;yield n,base,buffer,buffer.decode(enc,errors='replace').lstrip('\ufeff').rstrip('\r\n')
                    return
    with open_binary(path) as f:
        n = 0
        while True:
            offset = f.tell()
            b = f.readline()
            if not b:
                break
            n += 1
            text = b.decode(enc, errors='replace').lstrip('\ufeff').rstrip('\r\n')
            yield n, offset, b, text


def connect(run):
    db = sqlite3.connect(str(Path(run['workDir']) / 'index.sqlite'))
    db.row_factory = sqlite3.Row
    from .storage import configure
    configure(db)
    db.execute('pragma cache_size=-16384')
    db.execute('pragma temp_store=FILE')
    return db


def load(path):
    p = Path(path).resolve()
    if p.is_dir():
        p /= 'run.json'
    run = read(p)
    if Path(run['run']).resolve() != p or Path(run['workDir']).resolve() != p.parent:
        raise ValueError('任务路径与登记路径不一致')
    root = p.parent.parent
    if p.parent.name != 'work' or not (root / '.ula-owner').exists():
        raise ValueError('不是本工具创建的工作区')
    inside(p.parent, root)
    return run


def save(run):
    write(run['run'], run)


def decision(run, action, target, reason, result='ok'):
    run['decisions'].append(dict(action=action, target=target, reason=reason, result=result, at=now()))


def archive_members(path):
    try:
        if zipfile.is_zipfile(path):
            with zipfile.ZipFile(path) as z:
                return [{'name': i.filename, 'size': i.file_size} for i in z.infolist()]
        if tarfile.is_tarfile(path):
            with tarfile.open(path) as z:
                return [{'name': i.name, 'size': i.size} for i in z]
    except (OSError, tarfile.TarError, zipfile.BadZipFile) as e:
        return [{'error': str(e)}]
    return []


def start(args):
    candidates = [];skipped=[];roots={}
    for value in args.log:
        if value == '-':
            continue
        original = Path(value).expanduser().absolute()
        if original.is_symlink() or getattr(original.lstat(), 'st_file_attributes', 0) & 0x400:
            raise ValueError('输入不能是符号链接')
        p = original.resolve(strict=True)
        if p.is_dir():
            for directory,dirs,names in os.walk(p,followlinks=False):
                for name in dirs[:]:
                    child=Path(directory)/name
                    if child.is_symlink() or getattr(child.lstat(),'st_file_attributes',0)&0x400:
                        dirs.remove(name);skipped.append(dict(path=str(child),reason='跳过链接或重解析点'))
                for name in names:
                    child=Path(directory)/name
                    if child.is_symlink() or getattr(child.lstat(),'st_file_attributes',0)&0x400:
                        skipped.append(dict(path=str(child),reason='跳过链接或重解析点'))
                    else:
                        candidates.append(child)
                        roots.setdefault(str(child.resolve()),str(p))
        else:
            candidates.append(p)
            roots.setdefault(str(p),str(p.parent))
    candidates = list(dict.fromkeys(candidates))
    base = Path(args.out).expanduser().resolve() if args.out else Path(os.environ.get('ULA_REPORTS', str(Path.home() / 'LogReports'))).expanduser().resolve() / (dt.datetime.now().strftime('%Y%m%d-%H%M%S') + '-' + (candidates[0].stem[:36] if candidates else 'stdin'))
    # Never create output inside any input directory, nor snapshot our own output.
    for value in args.log:
        if value != '-' and Path(value).is_dir():
            p = Path(value).resolve()
            if base == p or p in base.parents:
                raise ValueError('输出不能位于输入目录内')
    out = base
    suffix = 1
    while out.exists():
        out = base.with_name(base.name + '-' + str(suffix)); suffix += 1
    out.mkdir(parents=True)
    (out / '.ula-owner').write_text('ula/2\n', encoding='ascii')
    work = out / 'work'; work.mkdir()
    run = dict(schemaVersion='ula/2', version=VERSION, run=str(work / 'run.json'), workDir=str(work), out=str(out), createdAt=now(), stage='inventory', sources=[], files=[], excluded=skipped, decisions=[], queries=[], segments=[], question=dict(raw=args.question or '', type=getattr(args,'question_type',None) or 'triage'), project=None, extensions=args.ext or [])
    run['build']=execution_identity(ROOT)
    if getattr(args,'problem_window',None):
        run['question']['problemWindow']=dict(range=args.problem_window,source='user')
    if args.project or args.project_cwd:
        run['project'] = dict(path=str(Path(args.project or Path.cwd()).resolve()), source='arg' if args.project else 'cwd', status='未校验代码线索')
    if '-' in args.log:
        p = work / 'stdin.log'
        with open(p,'wb') as f:
            shutil.copyfileobj(sys.stdin.buffer,f,length=1024*1024)
        candidates.append(p)
    for p in candidates:
        k = kind(p)
        item = dict(id='S' + str(len(run['sources']) + 1), path=str(p),sourceRoot=roots.get(str(p.resolve()),'stdin'), kind=k, size=p.stat().st_size, mtime=p.stat().st_mtime_ns, sha256=digest(p), consistency='same')
        if k == 'archive':
            item['members'] = archive_members(p)
        run['sources'].append(item)
    save(run)
    return dict(ok=True, run=run['run'], workDir=str(work), inventory=run['sources'], excluded=skipped, spaceEstimate=int(sum(s['size']*1.5 + sum(m.get('size', 0)*2.5 for m in s.get('members', [])) for s in run['sources'])), freeBytes=shutil.disk_usage(out).free, next='files: 明确纳入或排除；压缩包先 extract')


def target(run, value):
    for item in run['sources'] + run['files']:
        if value in (item['id'], item.get('path'), item.get('workPath')):
            return item
    raise ValueError('未登记的来源: ' + value)


def add_file(run, path, source, method, member=None, origin=None):
    p = Path(path).resolve(strict=True)
    if source['id'].startswith('F'):
        source_id = source['provenance']['sourceId']
        parents = source.get('provenance', {}).get('chain', []) + [dict(id=source['id'],sha256=source['sha256'],path=source['path'],member=source.get('provenance',{}).get('member'),method=source.get('provenance',{}).get('method'))]
    else:
        source_id, parents = source['id'], []
    number=run.get('nextFileId',max([int(f['id'][1:]) for f in run['files']] or [0])+1)
    run['nextFileId']=number+1
    stat=p.stat();reuse=source['id'].startswith('S') and str(p)==source.get('path') and stat.st_size==source.get('size') and stat.st_mtime_ns==source.get('mtime')
    source_root=source.get('sourceRoot') or next((s.get('sourceRoot',s['path']) for s in run['sources'] if s['id']==source_id),source_id)
    item = dict(id='F' + str(number), path=str(p),sourceRoot=source_root, workPath=None, origin=origin or ('original' if str(p) == source.get('path') else 'converted'), provenance=dict(sourceId=source_id, parent=source['id'], chain=parents, member=member, method=method), sha256=source['sha256'] if reuse else digest(p), kind=source['kind'] if reuse else kind(p))
    run['files'].append(item)
    decision(run, 'include', item['id'], method)
    return item


def files(args):
    run = load(args.run)
    if run['stage'] not in ('inventory', 'files'):
        raise ValueError('scan 后输入集合冻结；请新建任务')
    if args.action == 'add':
        source = target(run, args.source)
        p = Path(args.path or source.get('workPath') or source['path']).resolve(strict=True)
        if p != Path(source.get('path', source.get('workPath', ''))).resolve() or source['id'].startswith('F'):
            inside(p, run['workDir'])
        if any(f['path'] == str(p) for f in run['files']):
            raise ValueError('文件已登记')
        result = add_file(run, p, source, args.reason, origin='original' if source['id'].startswith('S') and p == Path(source['path']) else None)
    else:
        source = target(run, args.source)
        run['excluded'].append(dict(path=source.get('path'), id=source['id'], reason=args.reason))
        run['files'] = [f for f in run['files'] if f['id'] != source['id']]
        decision(run, 'drop', source['id'], args.reason)
        result = source['id']
    run['stage'] = 'files'; save(run)
    return dict(ok=True, result=result, next='scan' )


def extract(args):
    run = load(args.run)
    if run['stage'] not in ('inventory', 'files'):
        raise ValueError('scan 后不能解压')
    source = target(run, args.file)
    p = Path(source.get('workPath') or source['path'])
    if digest(p) != source['sha256']:
        raise ValueError('压缩来源已变化，请重新盘点')
    dest = Path(run['workDir']) / ('extract-' + source['id'])
    disk=shutil.disk_usage(run['workDir']);floor=max(1024**3,int(disk.total*0.05))
    if disk.free<floor:
        decision(run,'extract',source['id'],args.reason,'needs_decision: 磁盘空间保护');save(run)
        return dict(ok=True,needs_decision=True,freeBytes=disk.free,reserveBytes=floor,next='空间不足，由AI决定处理范围，不截取日志')
    dest.mkdir(exist_ok=True)
    accepted, rejected = [], []
    def store(name, stream, safe=True):
        to=None;created=False
        try:
            # Backslashes are separators on Windows, reject drive-qualified paths everywhere.
            if ':' in name or not safe:
                raise ValueError('不允许链接或特殊文件')
            to = inside(dest / name.replace('\\', '/'), dest)
            if to.exists():
                raise ValueError('重复或已存在的条目')
            to.parent.mkdir(parents=True, exist_ok=True)
            with open(to, 'xb') as f:
                created=True
                while True:
                    chunk=stream.read(1024*1024)
                    if not chunk:
                        break
                    if shutil.disk_usage(dest).free < floor+len(chunk):
                        raise OSError('needs_decision: 保留至少1GiB或5%磁盘空间')
                    f.write(chunk)
            accepted.append(add_file(run, to, source, args.reason, name, 'extracted'))
        except (ValueError,OSError,zipfile.BadZipFile,tarfile.TarError) as e:
            if created and to is not None and to.is_file() and not any(x['path']==str(to) for x in accepted):
                # Only the incomplete newly-created task file; never a source or existing member.
                to.unlink(missing_ok=True)
            rejected.append(dict(member=name, reason=str(e)))
    if zipfile.is_zipfile(p):
        with zipfile.ZipFile(p) as z:
            for i in z.infolist():
                if i.is_dir() or (args.members and i.filename not in args.members):
                    continue
                try:
                    with z.open(i) as f:
                        store(i.filename, f, not stat.S_ISLNK(i.external_attr >> 16))
                except (RuntimeError,OSError,zipfile.BadZipFile) as e:
                    rejected.append(dict(member=i.filename,reason=str(e)))
    elif tarfile.is_tarfile(p):
        with tarfile.open(p) as z:
            for i in z:
                if i.isdir() or (args.members and i.name not in args.members):
                    continue
                if not i.isfile():
                    rejected.append(dict(member=i.name, reason='不允许链接或特殊文件')); continue
                with z.extractfile(i) as f:
                    store(i.name, f)
    else:
        suffix = p.suffix.lower()
        opener = {'.gz': gzip.open, '.bz2': bz2.open, '.xz': lzma.open}.get(suffix)
        if not opener:
            raise ValueError('不支持的压缩格式')
        with opener(p, 'rb') as f:
            store(p.stem, f)
    decision(run, 'extract', source['id'], args.reason, dict(accepted=len(accepted), rejected=rejected))
    run['stage'] = 'files'; save(run)
    return dict(ok=True, files=accepted, rejected=rejected,needs_decision=any('needs_decision' in r['reason'] for r in rejected), extractedBytes=sum(Path(f['path']).stat().st_size for f in accepted), freeBytes=shutil.disk_usage(dest).free, next='files: 排除二进制/嵌套压缩条目或继续 extract')


def clean_work(run):
    work, out = Path(run['workDir']), Path(run['out']).resolve()
    if work.name != 'work' or work.resolve().parent != out or not (out / '.ula-owner').is_file() or work.is_symlink():
        raise ValueError('拒绝清理未经确认的工作区')
    # Reject all junctions/reparse points; no recursive traversal through links.
    paths = []
    for directory, dirs, names in os.walk(work, followlinks=False):
        for name in dirs + names:
            p=Path(directory)/name
            attrs=getattr(p.lstat(),'st_file_attributes',0)
            if p.is_symlink() or attrs & 0x400:
                raise ValueError('工作区有链接/重解析点，拒绝递归清理: '+str(p))
            paths.append(p)
    for p in [work] + paths:
        attrs = getattr(p.lstat(), 'st_file_attributes', 0)
        if p.is_symlink() or attrs & 0x400:
            raise ValueError('工作区有链接/重解析点，拒绝递归清理: ' + str(p))
        inside(p, out)
    size = sum(p.stat().st_size for p in paths if p.is_file())
    shutil.rmtree(work)
    return dict(status='cleaned', freedBytes=size, leftovers=[], at=now())
