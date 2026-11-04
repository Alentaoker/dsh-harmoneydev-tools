"""Recompute the mandatory, unfiltered neighborhood from snapshot bytes."""
from datetime import datetime,timedelta
import hashlib
from .core import inside
from .adapters import anomaly_priority,loss_marker,suspected_loss
from .snapshot import open_binary
from .storage import time_predicate,micros,decode_time,encode_time,parse_datetime
from .clocks import file_domain,value_domain,comparable


def anchor(db,file_id,line_number):
    row=db.execute('SELECT time FROM lines WHERE file=? AND n=?',(file_id,line_number)).fetchone()
    time=row['time'] if row else None
    inherited=None
    if not time:
        previous=db.execute('SELECT time,n FROM lines WHERE file=? AND n<=? AND time IS NOT NULL ORDER BY n DESC LIMIT 1',(file_id,line_number)).fetchone()
        following=None if previous else db.execute('SELECT time,n FROM lines WHERE file=? AND n>? AND time IS NOT NULL ORDER BY n LIMIT 1',(file_id,line_number)).fetchone()
        nearby=previous or following
        if nearby:
            time=nearby['time'];inherited=dict(line=nearby['n'],direction='previous' if previous else 'following')
    return dict(fileId=file_id,line=line_number,center=time or dict(fileId=file_id,line=line_number),inheritedTime=inherited)


def bounds(run,db,center,window=10):
    files={f['id']:f for f in run['files']}
    origin=None
    if isinstance(center,dict):
        origin=files[center['fileId']]
        resolved=anchor(db,center['fileId'],center['line'])['center']
        if not isinstance(resolved,str) or file_domain(origin) in ('none','mixed'):
            radius=200
            rng=dict(fileId=center['fileId'],lines=[max(1,center['line']-radius),min(origin['lineCount'],center['line']+radius)],domain=file_domain(origin),uncoveredFiles=[dict(fileId=f['id'],reason='中心无可比较时间') for f in run['files'] if f['id']!=origin['id']])
            if file_domain(origin)=='mixed':
                rng['uncoveredFiles'].append(dict(fileId=origin['id'],reason='混合时钟域，仅覆盖中心行窗'))
            return 'file=? AND n BETWEEN ? AND ?', [rng['fileId']]+rng['lines'],rng
        center=resolved
    domain=file_domain(origin) if origin else value_domain(center,center.startswith('2000-'))
    median=max((f.get('medianLineGapSeconds',0) for f in run['files']),default=0)
    radius=max(10,50*median,float(window));time=parse_datetime(center)
    lo=(time-timedelta(seconds=radius)).isoformat();hi=(time+timedelta(seconds=radius)).isoformat()
    # An unrelated, longer-running file must not suppress another file's tail.
    clauses=[];values=[];ranges=[];uncovered=[]
    for f in run['files']:
        if not comparable(domain,file_domain(f)):
            uncovered.append(dict(fileId=f['id'],reason='无有效时间行' if file_domain(f)=='none' else '时钟跨域'));continue
        flo,fhi=lo,hi;end=f.get('timeRange',[None,None])[1]
        if end and 0<=(micros(end)-micros(center))/1000000<60:
            fhi=end if micros(end)>micros(fhi) else fhi
        clause,params=time_predicate(flo,fhi)
        row=db.execute('SELECT MIN(n),MAX(n) FROM lines WHERE file=? AND '+clause,[f['id']]+params).fetchone()
        if row[0] is None:
            ranges.append(dict(fileId=f['id'],range=[flo,fhi],matches=0))
            continue
        next_timed=db.execute('SELECT MIN(n) FROM lines WHERE file=? AND n>? AND timeMs IS NOT NULL',(f['id'],row[1])).fetchone()[0]
        last_line=next_timed-1 if next_timed else f['lineCount']
        clauses.append('(file=? AND ('+clause+' OR (timeMs IS NULL AND n BETWEEN ? AND ?)))')
        values.extend([f['id']]+params+[row[0],last_line]);ranges.append(dict(fileId=f['id'],range=[flo,fhi],untimedLines=[row[0],last_line]))
    return '('+' OR '.join(clauses)+')' if clauses else '0',values,dict(time=[lo,max([hi]+[r['range'][1] for r in ranges],key=micros)],domain=domain,files=ranges,uncoveredFiles=uncovered)


def collect(run,db,center,window=10):
    return collect_union(run,db,[center],window)


def collect_union(run,db,centers,window=10):
    conditions=[];params=[];ranges=[]
    for center in centers:
        where,values,rng=bounds(run,db,center,window)
        conditions.append('('+where+')');params.extend(values);ranges.append(rng)
    where=' OR '.join(conditions) or '0'
    files={f['id']:f for f in run['files']};streams={};templates={};scanned=matches=0
    try:
        for row in db.execute('SELECT * FROM lines WHERE '+where+' ORDER BY file,n',params):
            scanned+=1;fid=row['file'];f=files[fid]
            if fid not in streams:
                streams[fid]=open_binary(inside(f['workPath'],run['workDir']))
            stream=streams[fid];stream.seek(row['off']);raw=stream.read(row['len'])
            text=raw.decode(f['encoding'],errors='replace').lstrip('\ufeff').rstrip('\r\n')
            priority=anomaly_priority(text,row['level'])
            if not priority:
                continue
            matches+=1;tid=hashlib.sha256(row['template'].encode()).hexdigest()[:12]
            item=templates.setdefault(tid,dict(id=tid,template=row['template'],count=0,refs=[],priority=priority,tags=[]))
            if loss_marker(text) and 'loss' not in item['tags']:
                item['tags'].append('loss')
            if suspected_loss(text) and 'suspected_loss' not in item['tags']:
                item['tags'].append('suspected_loss')
            item['count']+=1;item['priority']=max(item['priority'],priority)
            if len(item['refs'])<3:
                item['refs'].append(f"{fid}:L{row['n']}#{hashlib.sha256(raw).hexdigest()[:12]}")
    finally:
        for stream in streams.values():
            stream.close()
    times=[r['time'] for r in ranges if isinstance(r,dict) and 'time' in r]
    effective=[min((t[0] for t in times),key=micros),max((t[1] for t in times),key=micros)] if times else ranges[0] if len(ranges)==1 else ranges
    covered={f['fileId'] for r in ranges for f in r.get('files',[])}|{r['fileId'] for r in ranges if 'fileId' in r and r.get('domain')!='mixed'}
    uncovered={x['fileId']:x for r in ranges for x in r.get('uncoveredFiles',[]) if x['fileId'] not in covered}
    return dict(scope='all',spec=dict(kind='neighborhood',value=centers[0] if len(centers)==1 else centers,centers=centers,effectiveRange=effective,ranges=ranges),scannedLines=scanned,matches=matches,anomalyTemplates=list(templates.values()),uncoveredFiles=list(uncovered.values()),uncoveredUntimedFiles=[x for x in uncovered if file_domain(files[x])=='none'],recomputed=True)
