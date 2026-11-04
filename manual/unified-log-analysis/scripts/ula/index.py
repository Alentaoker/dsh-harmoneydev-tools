from collections import Counter
import hashlib
import json
import multiprocessing
from pathlib import Path
import re
import shutil
import time
import uuid
import gzip
from datetime import datetime,timedelta

from .core import connect, decision, digest, encoding_info, inside, load, now, raw_lines, save, write, read
from .adapters import parse,LIFECYCLE,loss_marker,anomaly_priority,id_kind,suspected_loss
from .snapshot import open_binary,shared_binary,reader_scope
from .storage import time_predicate,micros,decode_time,parse_datetime
from .clocks import value_domain,file_domain,comparable


def ledger_hash(q):
    return hashlib.sha256(json.dumps({k:v for k,v in q.items() if k!='ledgerHash'},sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()


def seal_query(run,q):
    q['questionHash']=hashlib.sha256(json.dumps(run.get('registeredQuestion',run['question']),sort_keys=True,ensure_ascii=False).encode()).hexdigest()
    q['resultHash']=digest(q['resultFile'])
    q['previousHash']=run['queries'][-1]['ledgerHash'] if run['queries'] else None
    q['ledgerHash']=ledger_hash(q)


def verify_ledger(run):
    prev=None
    question_hash=hashlib.sha256(json.dumps(run.get('registeredQuestion',run['question']),sort_keys=True,ensure_ascii=False).encode()).hexdigest()
    for q in run['queries']:
        if q.get('questionHash')!=question_hash or q.get('previousHash')!=prev or q.get('ledgerHash')!=ledger_hash(q) or digest(inside(q['resultFile'],run['workDir']))!=q.get('resultHash'):
            raise ValueError('检索账本或结果文件被修改: '+q.get('id','?'))
        prev=q['ledgerHash']


def id_stats(db,key,value):
    return dict(occurrences=db.execute('SELECT COUNT(*) FROM ids WHERE key=? AND value=?',(key,value)).fetchone()[0],kind=id_kind(key))


def scan(args):
    run = load(args.run)
    if run['stage'] not in ('inventory', 'files'):
        return dict(ok=True, coverage=run.get('coverage'), next='search', resumed=True)
    selected = {f['provenance']['sourceId'] for f in run['files']}
    excluded = {e.get('id') for e in run['excluded']}
    unresolved = [s['id'] for s in run['sources'] if s['id'] not in selected | excluded]
    if unresolved:
        raise ValueError('每个来源需明确纳入或排除: ' + ', '.join(unresolved))
    if not run['files']:
        raise ValueError('没有可分析文件')
    dbpath = Path(run['workDir']) / 'index.sqlite'
    dbpath.unlink(missing_ok=True)
    db = connect(run)
    from . import storage
    from .capture import snapshot
    storage.create(db);builder=storage.Builder(db)
    t0=time.monotonic();losses=[]
    try:
        for f in run['files']:
            if f['kind']!='text':
                raise ValueError('需先排除/转换非文本文件: '+f['id'])
            original=Path(f['path']);copy=inside(Path(run['workDir'])/'snapshots'/(f['id']+'-'+uuid.uuid4().hex+'.ulz'),run['workDir']);copy.parent.mkdir(exist_ok=True)
            capture=snapshot(original,copy);f['changedBeforeScan']=capture['sha256']!=f['sha256']
            f.update(workPath=str(copy),**capture);f['encodingConfidence']=f['confidence']
            f['snapshotStat']=dict(size=copy.stat().st_size,mtimeNs=copy.stat().st_mtime_ns)
            file_id=int(f['id'][1:]);db.execute('INSERT INTO files VALUES(?,?)',(file_id,f['id']))
            formats,levels=Counter(),Counter();first=last=previous_tick=first_tick=last_tick=None;inversions=replacements=count=timed=invalid_times=0;intervals=[];domains=set();decoded_hash=hashlib.sha256()
            for n,off,raw,text in raw_lines(copy,f['encoding']):
                decoded_hash.update(raw)
                parsed=parse(text);count=n;formats[parsed['format']]+=1;levels[parsed['level']]+=1;replacements+=text.count('\ufffd')
                loss=loss_marker(text)
                if loss:
                    loss.update(fileId=f['id'],ref=f"{f['id']}:L{n}#{hashlib.sha256(raw).hexdigest()[:12]}");losses.append(loss)
                if parsed['norm']:
                    timed+=1;domains.add(value_domain(parsed['norm'],parsed['format']=='hilog'))
                    tick=parsed['clock'][0]*1000+parsed['clock'][1]
                    if first_tick is None or tick<first_tick:
                        first_tick=tick;first=parsed['norm']
                    if last_tick is None or tick>last_tick:
                        last_tick=tick;last=parsed['norm']
                    inversions+=int(previous_tick is not None and tick<previous_tick)
                    if previous_tick is not None and tick>previous_tick and len(intervals)<4096:
                        intervals.append((tick-previous_tick)/1000000)
                    previous_tick=tick
                elif parsed['time']:
                    invalid_times+=1
                builder.feed(file_id,n,off,len(raw),parsed)
            if decoded_hash.hexdigest()!=f['sha256']:
                raise ValueError('SNAPSHOT_RAW_HASH: 解压字节与采集原始哈希不符')
            builder.flush()
            f.update(lineCount=count,format=formats.most_common(1)[0][0] if count else 'plain',parseRate=timed/count if count else 0,invalidTimeLines=invalid_times,timeRange=[first,last],inversions=inversions,replacements=replacements,levels=dict(levels),yearAssumed=bool(formats['hilog']),clockSource=None,clockDomain=next(iter(domains)) if len(domains)==1 else 'mixed' if domains else 'none',snapshotRawVerified=True)
            import statistics
            f['medianLineGapSeconds']=statistics.median(intervals) if intervals else 0
            f['medianGapSamples']=len(intervals)
        builder.finish();db.commit()
    finally:
        db.close()
    overlaps,gaps,continuities=[],[],[]
    domains={}
    for f in run['files']:
        domains.setdefault(file_domain(f),[]).append(f)
    for domain,members in domains.items():
        if domain in ('none','mixed'): continue
        ordered=sorted(members,key=lambda f:(micros(f['timeRange'][0]),f['id']))
        for prev,cur in zip(ordered,ordered[1:]):
            a,b=prev['timeRange'][1],cur['timeRange'][0]
            record=dict(fromFile=prev['id'],toFile=cur['id'],start=a,end=b,clockDomain=domain,clockComparable=False)
            if micros(b)<=micros(a):
                record.update(start=b,end=min((a,cur['timeRange'][1]),key=micros),continuity='overlap');overlaps.append(record);cur['order']='parallel'
            else:
                delta=(micros(b)-micros(a))/1000000;threshold=max(60,20*max(f['medianLineGapSeconds'] if f.get('medianGapSamples',0)>=20 else 0 for f in (prev,cur)))
                record.update(continuity='gap' if delta>threshold else 'contiguous',gapSeconds=delta,thresholdSeconds=threshold)
                if delta>threshold: gaps.append(record)
                cur['order']='rotation_candidate'
            continuities.append(record);cur['continuity']=record['continuity']
    count = sum(f['lineCount'] for f in run['files'])
    timed = sum(f['parseRate'] * f['lineCount'] for f in run['files'])
    db=connect(run)
    try:
        bounds=db.execute('SELECT MIN(t),MAX(t) FROM records WHERE t IS NOT NULL').fetchone()
        histogram=[]
        if bounds[0] is not None:
            duration=max(bounds[1]-bounds[0],1)
            histogram=[dict(r) for r in db.execute("SELECT MIN(399,CAST((t-?)*400.0/? AS INT)) bucket,COUNT(*) count,SUM(headers.level IN ('E','ERROR')) errors FROM records JOIN headers ON records.headerId=headers.id WHERE t IS NOT NULL GROUP BY bucket ORDER BY bucket",(bounds[0],duration))]
        run['histogram']=histogram
        template_count=db.execute('SELECT COUNT(*) FROM templates').fetchone()[0]
    finally:
        db.close()
    run['coverage'] = dict(files=len(run['files']), lines=count, scannedLines=count, gaps=gaps, overlaps=overlaps,continuities=continuities,gapThresholdMethod='max(60s,20×4096个正间隔抽样中位数)', replacements=sum(f['replacements'] for f in run['files']), unparsedLines=count-round(timed), time=dict(available='none' if not timed else 'all' if timed == count else 'partial', tz='unknown', yearAssumed=any(f['yearAssumed'] for f in run['files'])), scanSeconds=round(time.monotonic()-t0, 3), index='disposable SQLite v3; integer clocks + header/ID dictionaries; hashes on demand; 16MiB page cache')
    run['coverage'].update(templates=template_count,templateRatio=template_count/max(1,count))
    for loss in losses:
        f=next(f for f in run['files'] if f['id']==loss['fileId'])
        loss['clockDomain']=file_domain(f)
        loss['rawRange']=[loss['start'],loss['end']]
        if f['yearAssumed'] and loss['start']:
            loss['start']='2000'+loss['start'][4:];loss['end']='2000'+loss['end'][4:]
    run['coverage']['lossWindows']=losses
    if not run['question'].get('problemWindow'):
        firsts=[f['timeRange'][0] for f in run['files'] if f['timeRange'][0]];lasts=[f['timeRange'][1] for f in run['files'] if f['timeRange'][1]]
        run['question']['problemWindow']=dict(range=[min(firsts),max(lasts)] if firsts else None,source='inferred' if firsts else 'unavailable',reason='未提供问题时段，采用已解析日志的覆盖范围；不等于用户问题实际发生时段。')
    run['question']['registeredAt']=now();run['registeredQuestion']=json.loads(json.dumps(run['question']))
    run['splitSuggestions'] = [dict(file=f['id'], reason='超过 200MB 或 200万行，建议逻辑分段') for f in run['files'] if f.get('snapshotRawBytes',Path(f['workPath']).stat().st_size) >= 200*1024**2 or f['lineCount'] >= 2000000]
    run['indexBuild']=str(uuid.uuid4());run['stage'] = 'scanned'; save(run)
    return dict(ok=True, files=run['files'], coverage=run['coverage'], splitSuggestions=run['splitSuggestions'], next='segment 或 search')


def segment(args):
    run = load(args.run); db = connect(run); result = []
    if getattr(args,'deep',None):
        known={s['id'] for s in run['segments']}
        if not set(args.deep)<=known:
            db.close();raise ValueError('未知分段')
        for s in run['segments']:
            if s['id'] in args.deep:
                s['depth']='deep';s['reason']=args.reason or 'AI选定重点段'
        decision(run,'split',args.deep,args.reason or '标记深入分析段');save(run);db.close()
        return dict(ok=True,segments=run['segments'],next='search')
    window=getattr(args,'problem_window',None)
    if window:
        if run['queries']:
            db.close();raise ValueError('问题时段必须在首次检索前登记')
        run['question']['problemWindow']=dict(range=window,source='arg')
        run['question']['registeredAt']=now();run['registeredQuestion']=json.loads(json.dumps(run['question']))
    try:
        for f in run['files']:
            start, startoff, t0, lasttime, prevtime, nlast, endoff = 1, 0, None, None, None, 0, 0
            error = total = 0
            def emit(end, byteend):
                if end >= start:
                    top=[dict(r) for r in db.execute('SELECT template,COUNT(*) count FROM lines WHERE file=? AND n BETWEEN ? AND ? GROUP BY template ORDER BY count DESC LIMIT 5',(f['id'],start,end))]
                    result.append(dict(id='G'+str(len(result)+1), fileId=f['id'], lines=[start,end], bytes=[startoff,byteend], timeRange=[t0,lasttime],hasProblemWindow=(t0<=window[1] and lasttime>=window[0]) if window and t0 and lasttime else None, stats=dict(lines=total, warningsAndErrors=error, errorDensity=error/total if total else 0,topTemplates=top), depth='scanned', reason=args.by))
            for row in db.execute('SELECT * FROM lines WHERE file=? ORDER BY n', (f['id'],)):
                split = False
                if row['n'] > start:
                    restart=bool(LIFECYCLE.search(row['template']))
                    if args.by in ('auto','session') and restart:
                        split=True
                    if args.by == 'size':
                        split = row['off'] - startoff >= args.size
                    elif args.by in ('auto','time','session') and row['time'] and t0:
                        from datetime import datetime
                        try:
                            elapsed=(parse_datetime(row['time'])-parse_datetime(t0)).total_seconds()
                            silence=(parse_datetime(row['time'])-parse_datetime(prevtime)).total_seconds() if prevtime else 0
                            split = split or (elapsed >= args.window if args.by != 'session' else silence >= args.window)
                            if args.by == 'auto':
                                split = split or silence >= 60
                        except TypeError:
                            pass
                if split:
                    emit(row['n']-1,row['off']); start=row['n']; startoff=row['off']; t0=None; total=error=0
                total += 1; error += row['level'] in ('E','ERROR','W','WARN')
                t0=t0 or row['time']; lasttime=row['time'] or lasttime; prevtime=row['time'] or prevtime
                nlast=row['n']; endoff=row['off']+row['len']
            emit(nlast,endoff)
    finally:
        db.close()
    run['segments']=result; decision(run,'split','all',args.reason or args.by); save(run)
    run['segmentVersion']=run.get('segmentVersion',0)+1;save(run)
    return dict(ok=True,segments=result,next='search')


def line(run, row):
    f = next(x for x in run['files'] if x['id'] == row['file'])
    with shared_binary(inside(f['workPath'], run['workDir'])) as stream:
        stream.seek(row['off']); raw = stream.read(row['len'])
    line_hash=hashlib.sha256(raw).hexdigest();text=raw.decode(f['encoding'],errors='replace').lstrip('\ufeff').rstrip('\r\n')
    return dict(ref=f"{f['id']}:L{row['n']}#{line_hash[:12]}",fileId=f['id'],line=row['n'],lineHash=line_hash,text=text,time=parse(text)['time'])


def _regex_worker(pattern, texts, queue):
    try:
        rx=re.compile(pattern)
        queue.put([bool(rx.search(t)) for t in texts])
    except Exception as e:
        queue.put(str(e))


def search(args):
    with reader_scope():
        return _search(args)


def _search(args):
    run=load(args.run)
    if run['stage'] not in ('scanned','searched','checked'):
        raise ValueError('先 scan')
    spec=json.loads(args.spec); kind=spec.get('kind','literal'); value=spec.get('value','')
    limit=int(spec.get('max',200)); page=int(spec.get('page',1))
    if limit < 1 or limit > 2000 or page < 1:
        raise ValueError('max 为 1..2000，page >= 1；可继续翻页')
    allowed={'id','trace','literal','regex','lines','time','count','stats','compare','rare','neighborhood'}
    if kind not in allowed:
        raise ValueError('不支持的检索类型')
    if kind == 'regex' and (len(value)>256 or re.search(r'\\[1-9]|\(\?|[+*?}]\s*[+*?{]|\([^)]*[+*{][^)]*\)[+*{]',value)):
        raise ValueError('正则过长或含高风险结构；改用 literal/id')
    cachekey=hashlib.sha256(json.dumps([spec,run.get('indexBuild'),run.get('segmentVersion',0)],sort_keys=True,ensure_ascii=False).encode()).hexdigest()
    cache=Path(run['workDir'])/'cache'/(cachekey+'.json')
    if cache.exists() and not getattr(args,'no_cache',False):
        cached=read(cache);q=dict(cached['query']);q.update(id='Q'+str(len(run['queries'])+1),cacheOf=q['id'],seconds=0,physicalScannedLines=0,at=now())
        seal_query(run,q)
        run['queries'].append(q);run['stage']='searched';save(run)
        return dict(ok=True,untrusted=True,query=q,lines=cached['lines'],next='缓存命中；继续分析或成文',convergeHint=all(x.get('cacheOf') or x['matches']==0 for x in run['queries'][-3:]) and len(run['queries'])>=3)
    db=connect(run)
    try:
        t0=time.monotonic(); where=[]; values=[]
        scope=spec.get('scope','all')
        if scope != 'all':
            if not isinstance(scope,dict):
                raise ValueError('scope 必须是 all 或 {files:[...],segments:[...]}')
            if scope.get('files'):
                known={f['id'] for f in run['files']}
                if not set(scope['files']) <= known:
                    raise ValueError('未知文件')
                where.append('file IN ('+','.join('?' for _ in scope['files'])+')'); values.extend(scope['files'])
            if scope.get('segments'):
                clauses=[]
                for sid in scope['segments']:
                    seg=next((x for x in run['segments'] if x['id']==sid),None)
                    if not seg:
                        raise ValueError('未知分段')
                    clauses.append('(file=? AND n BETWEEN ? AND ?)'); values.extend([seg['fileId']]+seg['lines'])
                where.append('('+' OR '.join(clauses)+')')
        rng=spec.get('range')
        if kind in ('lines','time'):
            if not rng or len(rng)!=2:
                raise ValueError('lines/time 需要 range:[start,end]')
            if kind=='lines':
                where.append('n BETWEEN ? AND ?');values.extend(rng)
            else:
                clause,params=time_predicate(*rng);where.append(clause);values.extend(params)
        if kind in ('id','trace'):
            if not value:
                raise ValueError('ID 不得为空')
            where.append('(file,n) IN (SELECT file,n FROM ids WHERE value=?)'); values.append(str(value))
        filters=spec.get('filters',{})
        if filters.get('id'):
            where.append('(file,n) IN (SELECT file,n FROM ids WHERE value=? AND (?="" OR key=?))');values.extend([str(filters['id']),filters.get('idKey','').lower(),filters.get('idKey','').lower()])
        for name,col in [('tag','tag'),('level','level')]:
            if filters.get(name):
                where.append('instr('+col+',?)>0');values.append(filters[name])
        if filters.get('range'):
            clause,params=time_predicate(*filters['range']);where.append(clause);values.extend(params)
        if kind=='neighborhood':
            from .neighborhood import bounds
            clause,params,rng=bounds(run,db,value,spec.get('window',10))
            where.append(clause);values.extend(params);spec['effectiveRange']=rng.get('time',rng) if isinstance(rng,dict) else rng
        columns='*' if kind in ('stats','rare','compare','neighborhood') else 'file,n,off,len'
        sql='SELECT '+columns+' FROM lines'+(' WHERE '+' AND '.join(where) if where else '')+' ORDER BY file,n'
        output=Path(run['workDir'])/'queries'; output.mkdir(exist_ok=True)
        qid='Q'+str(len(run['queries'])+1); resultfile=output/(qid+'.jsonl.gz')
        matches=scanned=0; distribution=Counter(); result=[];anomalies={};total_templates=None
        # Stats/rare/compare keep aggregation in a disk-backed disposable index.
        if kind in ('stats','rare','compare'):
            if kind=='compare':
                if scope!='all':
                    raise ValueError('compare 当前只支持全集时间范围，不能忽略子集范围')
                a,b=spec.get('a'),spec.get('b')
                if not a:
                    raise ValueError('compare 需要问题时间范围 a')
                registered=run.get('registeredQuestion',run['question']).get('problemWindow',{})
                if a!=(registered.get('range') if isinstance(registered,dict) else registered):
                    raise ValueError('compare 的 a 必须等于检索前登记的问题时段')
                ad=(parse_datetime(a[1])-parse_datetime(a[0])).total_seconds()
                if ad<=0:
                    raise ValueError('问题窗口需有正时长')
                domain=value_domain(a[0],a[0].startswith('2000-'))
                if value_domain(a[1],a[1].startswith('2000-'))!=domain: raise ValueError('问题窗口跨时钟域')
                eligible=[f for f in run['files'] if file_domain(f)==domain]
                if not eligible: raise ValueError('没有与问题时段同域的文件')
                excluded=[dict(fileId=f['id'],domain=file_domain(f),reason='时钟域不匹配，未纳入对比') for f in run['files'] if f not in eligible]
                covered=[]
                for lo,hi in sorted([list(map(micros,f['timeRange'])) for f in eligible]):
                    if covered and lo<=covered[-1][1]: covered[-1][1]=max(covered[-1][1],hi)
                    else: covered.append([lo,hi])
                alo,ahi=map(micros,a)
                if b:
                    if value_domain(b[0],b[0].startswith('2000-'))!=domain or value_domain(b[1],b[1].startswith('2000-'))!=domain: raise ValueError('基线窗口跨时钟域')
                    blo,bhi=map(micros,b)
                    if not (bhi<=alo or blo>=ahi): raise ValueError('自定义基线必须与问题窗口不重叠')
                    bd=sum(max(0,min(hi,bhi)-max(lo,blo)) for lo,hi in covered)/1000000
                    if bd<ad: raise ValueError('有效覆盖基线不能短于问题窗口')
                    bsql='timeUs>=? AND timeUs<?';params=[alo,ahi,blo,bhi]
                else:
                    bd=sum(hi-lo-max(0,min(hi,ahi)-max(lo,alo)) for lo,hi in covered)/1000000
                    if bd<=0: raise ValueError('同域覆盖减去问题窗口后没有基线时长')
                    bsql='NOT (timeUs>=? AND timeUs<?)';params=[alo,ahi,alo,ahi]
                file_ids=[f['id'] for f in eligible];file_where='file IN ('+','.join('?' for _ in file_ids)+')'
                grouped='SELECT template,SUM(timeUs>=? AND timeUs<?) a,SUM('+bsql+') b FROM lines WHERE '+file_where+' GROUP BY template HAVING a>0 OR b>0'
                rows=db.execute(grouped+' ORDER BY ((a+1)/?)/((b+1)/?) DESC LIMIT ?',params+file_ids+[ad,bd,limit]).fetchall()
                sql='SELECT * FROM lines WHERE '+file_where;values=file_ids
                result=[dict(**dict(r),rateA=r['a']/ad,rateB=r['b']/bd,ratio=((r['a']+1)/ad)/((r['b']+1)/bd),observed=r['a'],expected=r['b']/bd*ad) for r in rows]
                spec['clockCoverage']=dict(domain=domain,files=file_ids,excludedFiles=excluded,intervals=covered)
                spec['comparisonWindows']=dict(a=a,b=b or 'complement',durationA=ad,durationB=bd)
            else:
                order='ASC' if kind=='rare' else 'DESC'
                rows=db.execute('SELECT template,COUNT(*) count,MIN(timeMs) firstTimeMs FROM ('+sql+') GROUP BY template ORDER BY count '+order+' LIMIT ?',values+[limit]).fetchall()
                result=[dict(**dict(r),firstTime=decode_time(r['firstTimeMs'])) for r in rows]
            total_templates=db.execute('SELECT COUNT(DISTINCT template) FROM ('+sql+')',values).fetchone()[0]
            matches=total_templates; scanned=db.execute('SELECT COUNT(*) FROM ('+sql+')',values).fetchone()[0]
            resultfile=resultfile.with_suffix('.json');write(resultfile,result)
        else:
            stream_cache={}
            def text_for(row):
                fid=row['file']
                if fid not in stream_cache:
                    f=next(x for x in run['files'] if x['id']==fid)
                    stream_cache[fid]=(open_binary(inside(f['workPath'],run['workDir'])),f['encoding'])
                stream,enc=stream_cache[fid]
                if stream.tell()!=row['off']:
                    stream.seek(row['off'])
                return stream.read(row['len']).decode(enc,errors='replace').lstrip('\ufeff').rstrip('\r\n')
            pool=multiprocessing.Pool(1) if kind=='regex' else None
            try:
                with gzip.open(resultfile,'wt',encoding='utf-8',compresslevel=1) as out:
                    cur=db.execute(sql,values)
                    while True:
                        batch=cur.fetchmany(1000)
                        if not batch:
                            break
                        if kind=='regex':
                            # A hung regex is killed; it cannot block the host process.
                            job=pool.apply_async(_regex_batch,(value,[text_for(r) for r in batch],bool(spec.get('ignoreCase',False))))
                            try:
                                flags=job.get(timeout=3)
                            except multiprocessing.TimeoutError:
                                raise ValueError('正则超时，已终止该次检索')
                        else:
                            flags=None
                        for i,row in enumerate(batch):
                            scanned+=1
                            hit=flags[i] if flags is not None else (str(value).casefold() in text_for(row).casefold() if kind in ('literal','count') else True)
                            if kind=='neighborhood':
                                priority=anomaly_priority(text_for(row),row['level']);hit=priority>0
                            if not hit:
                                continue
                            matches+=1; distribution[row['file']]+=1
                            record=dict(file=row['file'],line=row['n'])
                            if kind=='neighborhood':
                                tid=hashlib.sha256(row['template'].encode()).hexdigest()[:12]
                                a=anomalies.setdefault(tid,dict(id=tid,template=row['template'],count=0,refs=[],priority=priority,tags=[]));a['count']+=1;a['priority']=max(a['priority'],priority)
                                if suspected_loss(text_for(row)) and 'suspected_loss' not in a['tags']:
                                    a['tags'].append('suspected_loss')
                                if len(a['refs'])<3:
                                    a['refs'].append(line(run,row)['ref'])
                            if kind!='count':
                                out.write(json.dumps(record)+'\n')
                            if kind!='count' and (page-1)*limit < matches <= page*limit:
                                result.append(line(run,row))
                    if kind=='count':
                        out.write(json.dumps(dict(matches=matches,scannedLines=scanned,distribution=dict(distribution)))+'\n')
            finally:
                for stream,_ in stream_cache.values():
                    stream.close()
                if pool:
                    pool.terminate(); pool.join()
        q=dict(id=qid,purpose='replay' if getattr(args,'replay',False) else 'analysis',spec=spec,scope=scope,scanned='full',scannedLines=scanned,matches=matches,distribution=dict(distribution),truncated=(kind not in ('count','stats','rare','compare') and matches>page*limit),page=page,seconds=round(time.monotonic()-t0,3),resultFile=str(resultfile),at=now())
        if kind in ('id','trace'):
            keys=[r[0] for r in db.execute('SELECT DISTINCT key FROM ids WHERE value=?',(str(value),))]
            q['idStats']=[dict(key=key,value=str(value),**id_stats(db,key,str(value))) for key in keys]
        if total_templates is not None:
            q.update(totalTemplates=total_templates,truncated=total_templates>len(result))
        if kind=='neighborhood':
            q['anomalyTemplates']=list(anomalies.values())
            q['coverageRanges']=rng
            q['uncoveredFiles']=rng.get('uncoveredFiles',[]) if isinstance(rng,dict) else []
        # Only tool-produced ledger is authoritative to check; draft queries are ignored.
        seal_query(run,q)
        run['queries'].append(q); run['stage']='searched'; save(run)
        write(cache,dict(query=q,lines=result))
        return dict(ok=True,untrusted=True,query=q,lines=result,next='继续缩小范围/翻页；充分时编写草稿',convergeHint=len(run['queries'])>=3 and all(x['matches']==0 for x in run['queries'][-3:]))
    finally:
        db.close()


def _regex_batch(pattern,texts,ignore_case=False):
    rx=re.compile(pattern,re.I if ignore_case else 0)
    return [bool(rx.search(t)) for t in texts]
