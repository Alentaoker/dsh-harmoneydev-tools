"""Tool-owned context and structural cause ceiling for the beta report."""
from .adapters import id_kind,distinctive
from .neighborhood import anchor,collect_union
from .clocks import comparable,file_domain,value_domain
from .storage import micros
from .loss import summary


def positions(db,event,evidence):
    return [anchor(db,evidence[e]['fileId'],evidence[e]['lines'][0]) for e in event.get('evidence',[]) if evidence.get(e,{}).get('status')=='supported']


def row_ids(db,p):
    return {(r['key'],r['value']) for r in db.execute('SELECT key,value FROM ids WHERE file=? AND n=?',(p['fileId'],p['line'])) if id_kind(r['key'])=='other' and distinctive(r['value'])}


def relative(p,q,files):
    if p['fileId']==q['fileId']: return p['line']>q['line']
    if isinstance(p['center'],str) and isinstance(q['center'],str) and comparable(file_domain(files[p['fileId']]),file_domain(files[q['fileId']])):
        return micros(p['center'])>micros(q['center'])
    return None


def template_rate(run,db,template,window,domain):
    """Per-second rates over the union of comparable file coverage."""
    if not window or len(window)!=2: return None
    lo,hi=map(micros,window);intervals=[];counts=[0,0]
    for f in run['files']:
        if not comparable(domain,file_domain(f)) or not all(f.get('timeRange',[])): continue
        intervals.append(tuple(map(micros,f['timeRange'])))
        for row in db.execute('SELECT time FROM lines WHERE file=? AND template=? AND time IS NOT NULL',(f['id'],template)):
            counts[0 if lo<=micros(row['time'])<=hi else 1]+=1
    union=[]
    for a,b in sorted(intervals):
        if union and a<=union[-1][1]: union[-1][1]=max(b,union[-1][1])
        else: union.append([a,b])
    duration=sum(b-a for a,b in union)/1e6
    inside=sum(max(0,min(b,hi)-max(a,lo)) for a,b in union)/1e6
    outside=duration-inside
    if inside<=0 or outside<=0: return None
    rate=counts[0]/inside;base=counts[1]/outside
    return dict(windowCount=counts[0],baselineCount=counts[1],windowSeconds=inside,baselineSeconds=outside,ratio=rate/base if base else None,newInWindow=bool(counts[0] and not counts[1]))


def cap_cause(run,db,diagnosis,evidence,hypotheses):
    claimed=diagnosis.get('causeStatus','not_applicable');reasons=[];links=[]
    anchor_=diagnosis.get('anchor')
    cause=diagnosis.get('cause',{});ids=row_ids(db,anchor_) if anchor_ else set()
    if claimed in ('confirmed','likely'):
        valid=[]
        for eid in cause.get('evidence',[]):
            e=evidence.get(eid,{})
            if e.get('status')!='supported' or not anchor_: continue
            p=anchor(db,e['fileId'],e['lines'][0]);shared=ids & row_ids(db,p);same=(p['fileId'],p['line'])==(anchor_['fileId'],anchor_['line'])
            ordered=relative(p,anchor_,{f['id']:f for f in run['files']}) is False
            linked=(same or bool(shared)) if claimed=='confirmed' else bool(shared)
            if linked and ordered:
                links.append(dict(evidence=eid,mode='same_line' if same else 'shared_id',sharedIds=[dict(key=k,value=v) for k,v in sorted(shared)]));valid.append(e)
        if not valid: reasons.append('原因记录未与锚行建立可核对且有序的直接关联')
        if claimed=='confirmed' and (not cause.get('explicitReason') or not any(cause['explicitReason'] in e.get('quote','') for e in valid)): reasons.append('原因未由有效引文明确给出')
        if claimed=='likely':
            if not any(h.get('status')=='refuted' and h.get('against') and all(evidence.get(e,{}).get('status')=='supported' for e in h['against']) for h in hypotheses.values()): reasons.append('未提供带有效反证的已排除假设')
            window=run.get('registeredQuestion',run['question']).get('problemWindow')
            if not window or (isinstance(window,dict) and window.get('source') in ('inferred','unavailable')):
                reasons.append('未在首次检索前登记问题时段（当前为推定范围），无法做速率对照')
            else:
                window=window.get('range') if isinstance(window,dict) else window
                rates=[]
                for e in valid:
                    t=db.execute('SELECT template FROM lines WHERE file=? AND n=?',(e['fileId'],e['lines'][0])).fetchone()[0]
                    rates.append(template_rate(run,db,t,window,file_domain(next(f for f in run['files'] if f['id']==e['fileId']))))
                diagnosis['causeRates']=rates
                if not any(r and ((r['ratio'] is not None and r['ratio']>1.5) or r['newInWindow']) for r in rates): reasons.append('同一时钟域内的问题时段速率未高于其余时段1.5倍，或范围不足以比较')
    checked='possible' if reasons else claimed
    diagnosis.update(causeStatus=checked,causeAssessment=dict(ai=claimed,checked=checked,reasons=reasons),causeLinks=links)


def context(run,db,events,evidence,diagnosis,error,warnings):
    from .index import line
    last=events.get(diagnosis.get('lastVisible'))
    if not last or last.get('status')!='supported':
        if diagnosis.get('lastVisible'): error('diagnosis.lastVisible','UNSUPPORTED','最后可见点没有通过的事件证据')
        if diagnosis.pop('lastVisibleLine',None): warnings.append(dict(code='ANCHOR_IGNORED',hint='未声明有效最后可见点，已忽略单独填写的锚行'))
        return
    refs=positions(db,last,evidence)
    requested=diagnosis.get('lastVisibleLine')
    valid=[e for e in last['evidence'] if evidence.get(e,{}).get('status')=='supported']
    if requested and requested not in valid:
        error('diagnosis.lastVisibleLine','ANCHOR_REQUIRED','锚行必须来自最后可见事件');return
    chosen=requested or max(valid,key=lambda eid:(evidence[eid]['fileId'],evidence[eid]['lines'][0]))
    diagnosis['lastVisibleLine']=chosen;p=anchor(db,evidence[chosen]['fileId'],evidence[chosen]['lines'][0]);files={f['id']:f for f in run['files']}
    diagnosis['anchor']=dict(**p,evidence=chosen)
    main=[r for e in events.values() if e.get('status')=='supported' and e.get('role','main')=='main' for r in positions(db,e,evidence)]
    ids={v for r in main for v in row_ids(db,r)};after_events=[]
    for e in events.values():
        if e.get('status')!='supported' or e['id']==last['id']: continue
        later=[r for r in positions(db,e,evidence) if relative(r,p,files)]
        if later:
            after_events.append(dict(eventId=e['id'],role=e.get('role','main'),title=e.get('title'),positions=later))
            if e.get('role','main')=='main': error('diagnosis.lastVisible','LAST_VISIBLE_NOT_LAST','最后可见点之后仍有主链事件：'+e['id'])
    follow=[]
    for key,value in sorted(ids):
        count=unknown=0;rows=[]
        for r in db.execute('SELECT lines.* FROM ids JOIN lines ON lines.file=ids.file AND lines.n=ids.n WHERE ids.key=? AND ids.value=? ORDER BY lines.file,lines.n',(key,value)):
            later=relative(dict(fileId=r['file'],line=r['n'],center=r['time']),p,files)
            if later is True:
                count+=1
                if len(rows)<10: rows.append(line(run,r))
            elif later is None: unknown+=1
        total=db.execute('SELECT COUNT(*) FROM ids WHERE key=? AND value=?',(key,value)).fetchone()[0]
        follow.append(dict(key=key,value=value,occurrences=total,count=count,unorderedCount=unknown,rows=rows,truncated=count>len(rows)))
    centers=refs
    n=collect_union(run,db,[dict(fileId=r['fileId'],line=r['line']) for r in centers]);n['anchors']=centers
    discussed={evidence[x]['ref'] for f in diagnosis.get('_findings',[]) for x in f.get('supports',{}).get('evidence',[]) if evidence.get(x,{}).get('status')=='supported'}
    for t in n['anomalyTemplates']:
        first=db.execute('SELECT file,n,time FROM lines WHERE template=? ORDER BY file,n LIMIT 1',(t['template'],)).fetchone()
        t['firstInNeighborhood']=bool(first and any(r.startswith(first['file']+':L'+str(first['n'])+'#') for r in t['refs']))
        window=next((r.get('time') for r in n['spec']['ranges'] if r.get('time')),None)
        t['rate']=template_rate(run,db,t['template'],window,file_domain(files[p['fileId']]))
        t['discussed']=bool(set(t['refs']) & discussed)
    n['anomalyTemplates'].sort(key=lambda t:(not t['firstInNeighborhood'],-(t['rate']['ratio'] if t['rate'] and t['rate']['ratio'] is not None else 1e9 if t['rate'] and t['rate']['newInWindow'] else 0),-t['priority'],t['id']))
    n['lossSummary']=summary(run['coverage'].get('lossWindows',[]))
    diagnosis.update(followups=follow,afterEvents=after_events,neighborhood=n)
