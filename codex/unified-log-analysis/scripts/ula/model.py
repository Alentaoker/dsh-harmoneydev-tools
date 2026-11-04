import copy
import hashlib
from pathlib import Path
import re

from .core import ROOT,connect, digest, inside, load, read, save, write
from .index import line,verify_ledger,id_stats
from .adapters import parse,id_kind,distinctive
from .neighborhood import collect_union
from .beta import context,cap_cause
from .loss import summary as loss_summary
from .storage import micros
from .clocks import file_domain,value_domain,comparable
from .questions import negative_fact
from .snapshot import reader_scope
from .provenance import execution_identity

CAUSE=re.compile(r'导致|因为|由于|根因|引起|造成|致使|原因是|caused by|root cause|because|due to|led to|result(?:ed)? in',re.I)


def empty_draft():
    return dict(schemaVersion='ula/2',title='日志分析',question={'type':'triage','raw':''},evidence=[],events=[],relations=[],findings=[],hypotheses=[],diagnosis={'causeStatus':'not_applicable'},extensions={})


def check_report(run, draft,full_hash=True):
    with reader_scope():
        return _check_report(run,draft,full_hash)


def _check_report(run, draft,full_hash=True):
    report=copy.deepcopy(draft); errors=[]; demoted=[]; warnings=[]
    proposed=report.get('question',{})
    report['question']=copy.deepcopy(run.get('registeredQuestion',run['question']))
    report['question']['restatement']=proposed.get('restatement','')
    change=proposed.get('typeChange',{})
    if change:
        errors.append(dict(path='question.typeChange',code='QUESTION_REGISTRATION',hint='问题类型与理由必须在首次检索前登记，草稿不能更改'))
    # Tool-owned fields are rebuilt even for rejected evidence.
    if isinstance(report.get('evidence'),list):
        report['evidence']=[{k:copy.deepcopy(v) for k,v in e.items() if k in ('id','ref','quote','fields')} if isinstance(e,dict) else e for e in report['evidence']]
    for finding in report.get('findings',[]) if isinstance(report.get('findings'),list) else []:
        if isinstance(finding,dict):
            for key in ('qualification','lossImpact','lossSummary'):
                finding.pop(key,None)
            if finding.get('type') in ('gap','fact','caution'):
                finding.pop('strength',None)
    for relation in report.get('relations',[]) if isinstance(report.get('relations'),list) else []:
        if isinstance(relation,dict):
            relation.pop('idStats',None)
    if isinstance(report.get('diagnosis'),dict):
        allowed=('causeStatus','lastVisible','lastVisibleLine','firstMissing','insufficiency','suggestions','cause','unlinkedAnomalies')
        report['diagnosis']={k:v for k,v in report['diagnosis'].items() if k in allowed}
        for field in ('checkHistory','repairHistory'): report.pop(field,None)
    def error(path,code,hint):
        errors.append(dict(path=path,code=code,hint=hint))
    def demote(item,reason,cascade=None):
        item['status']='unsupported'
        demoted.append(dict(id=item.get('id','?'),reason=reason,cascadeFrom=cascade))
    report['build']=copy.deepcopy(run.get('build',{}))
    if run.get('build')!=execution_identity(ROOT):
        warnings.append(dict(code='BUILD_CHANGED',hint='执行期间构建身份变化，身份未核验'));report['build']=execution_identity(ROOT);report['build']['identityStatus']='unverified'
    for key in ('evidence','events','relations','findings','hypotheses'):
        if not isinstance(report.get(key),list):
            error(key,'STRUCTURE','必须为数组')
    if errors:
        return report,dict(status='fail',errors=errors,demoted=[],warnings=[])
    try:
        verify_ledger(run)
    except (ValueError,OSError) as e:
        error('queries','LEDGER',str(e));return report,dict(status='fail',errors=errors,demoted=[],warnings=[])
    if report.get('schemaVersion')!='ula/2':
        error('schemaVersion','SCHEMA','需要 ula/2；旧报告用 legacy 命令')
    ids=[]
    for group in ('evidence','events','relations','findings','hypotheses'):
        for item in report[group]:
            if not isinstance(item,dict) or not isinstance(item.get('id'),str):
                error(group,'ID','每项须有字符串 id'); continue
            ids.append(item['id'])
            for key in ('evidence','fields','for','against','queries'):
                if key in item and not isinstance(item[key],list):
                    error(item['id']+'.'+key,'STRUCTURE','必须为数组')
            for key in ('supports','tech'):
                if key in item and not isinstance(item[key],dict):
                    error(item['id']+'.'+key,'STRUCTURE','必须为对象')
            if group=='events' and 'time' in item and item['time'] is not None and not isinstance(item['time'],dict):
                error(item['id']+'.time','STRUCTURE','必须为对象或null')
    if not isinstance(report.get('diagnosis'),dict) or not isinstance(report.get('extensions',{}),dict):
        error('diagnosis/extensions','STRUCTURE','必须为对象')
    if len(ids)!=len(set(ids)):
        error('id','DUPLICATE','id 必须全局唯一')
    if errors:
        return report,dict(status='fail',errors=errors,demoted=[],warnings=[])
    files={f['id']:f for f in run['files']}
    for f in files.values():
        path=inside(f['workPath'],run['workDir'])
        info=path.stat();same_stat=f.get('snapshotStat')==dict(size=info.st_size,mtimeNs=info.st_mtime_ns)
        if (full_hash or not same_stat) and digest(path)!=f.get('snapshotSha256',f['sha256']):
            error(f['id'],'SNAPSHOT_HASH','工作副本已变化，拒绝整份报告')
    for source in run['sources']:
        p=Path(source['path'])
        same_stat=p.exists() and p.stat().st_size==source['size'] and p.stat().st_mtime_ns==source['mtime']
        source['consistency']='missing' if not p.exists() else 'same' if (same_stat and not full_hash) or digest(p)==source['sha256'] else 'changed'
    if errors:
        return report,dict(status='fail',errors=errors,demoted=[],warnings=[])
    db=connect(run)
    evidence={x['id']:x for x in report['evidence']}
    events={x['id']:x for x in report['events']}
    relations={x['id']:x for x in report['relations']}
    hypotheses={x['id']:x for x in report['hypotheses']}
    query={x['id']:x for x in run['queries']}
    def supported(refs, registry):
        return isinstance(refs,list) and bool(refs) and all(x in registry and registry[x].get('status')=='supported' for x in refs)
    try:
        for e in evidence.values():
            e['status']='supported'
            m=re.fullmatch(r'(F\d+):L(\d+)#([a-f0-9]{12})',e.get('ref',''))
            if not m or m[1] not in files:
                demote(e,'无效来源令牌'); continue
            fid,n,short=m[1],int(m[2]),m[3]
            row=db.execute('SELECT * FROM lines WHERE file=? AND n=?',(fid,n)).fetchone()
            if not row:
                demote(e,'行号/hash 不一致'); continue
            actual=line(run,row)
            if actual['lineHash'][:12]!=short:
                demote(e,'行号/hash 不一致');continue
            quote=e.get('quote')
            if not isinstance(quote,str) or len(''.join(quote.split()))<8 or len(quote)>1600 or quote not in actual['text']:
                demote(e,'引文不是原行的连续子串'); continue
            if actual['text'].find(quote)+len(quote)<=parse(actual['text'])['messageStart']:
                demote(e,'引文只包含时间或日志头');continue
            e.update(fileId=fid,lines=[n,n],lineHash=actual['lineHash'],time=actual['time'])
            e['fields']=[{k:v for k,v in field.items() if k in ('key','raw','norm','rule')} for field in e.get('fields',[]) if isinstance(field,dict)]
            e['context']=[line(run,r) for r in db.execute('SELECT * FROM lines WHERE file=? AND n BETWEEN ? AND ? ORDER BY n',(fid,max(1,n-3),n+3))]
            for field in e.get('fields',[]):
                raw=field.get('raw'); rule=field.get('rule','identity')
                if not isinstance(raw,str) or raw not in quote:
                    demote(e,'原始字段不在引文中'); break
                try:
                    norm={'identity':lambda x:x,'lower':str.lower,'hex':lambda x:format(int(x.removeprefix('0x'),16),'x'),'id_punctuation':lambda x:x.rstrip('.:')}[rule](raw)
                except (KeyError,ValueError):
                    demote(e,'未知/无效规范化规则'); break
                if field.get('norm')!=norm:
                    demote(e,'字段规范化不一致'); break
                actual_fields=parse(quote)['ids']
                if not any(x['key'].lower()==field.get('key','').lower() and x['raw']==raw for x in actual_fields):
                    demote(e,'原始字段不属于所声明的ID命名空间'); break
        for ev in events.values():
            ev['status']='supported'
            ev['aiNotes']=ev.pop('tech',{})
            ev['tech']=[]
            for eid in ev.get('evidence',[]):
                if evidence.get(eid,{}).get('status')=='supported':
                    e=evidence[eid];actual=next(x for x in e['context'] if x['line']==e['lines'][0]);fields=parse(actual['text'])
                    ev['tech'].append(dict(fileId=e['fileId'],line=e['lines'][0],**{k:fields[k] for k in ('tag','pid','tid','ids')}))
            refs=ev.get('evidence',[])
            if not supported(refs,evidence):
                good=[x for x in refs if x in evidence and evidence[x]['status']=='supported']
                if good:
                    ev['status']='weakened'; demoted.append(dict(id=ev['id'],reason='部分证据失效',cascadeFrom=refs))
                else:
                    demote(ev,'没有有效证据',refs)
            time=ev.get('time')
            if time is not None:
                raw=time.get('raw') if isinstance(time,dict) else None
                if not raw or not any(evidence.get(x,{}).get('status')=='supported' and evidence.get(x,{}).get('time')==raw for x in refs):
                    demote(ev,'时间未经证据原行核对',refs)
                else:
                    expected=parse(raw+' 0 0 I tag: x')['norm'] if re.match(r'^\d\d-\d\d ',raw) else parse(raw+' x')['norm']
                    if time.get('norm') not in (None,expected):
                        demote(ev,'规范化时间不一致',refs)
                    time['norm']=expected
            if len(ev.get('title',''))>48 or re.search(r'[a-fA-F0-9]{12,}|\b\w*Id=',ev.get('title','')):
                warnings.append(dict(id=ev['id'],code='READABILITY',hint='标题宜用简短业务语言，ID 放技术详情'))
        diagnosis=report['diagnosis']
        diagnosis['_findings']=report['findings']
        context(run,db,events,evidence,diagnosis,error,warnings)
        diagnosis.pop('_findings',None)
        cap_cause(run,db,diagnosis,evidence,hypotheses)
        for ev in events.values():
            if diagnosis.get('causeStatus') not in ('confirmed','likely') and CAUSE.search(ev.get('title','')+' '+ev.get('detail','')):
                demote(ev,'工具核对后的原因等级不足以支持因果断言')
        for r in relations.values():
            r['status']='supported'; a,b=events.get(r.get('from')),events.get(r.get('to'))
            if not a or not b or a['status']!='supported' or b['status']!='supported' or not supported(r.get('evidence'),evidence):
                demote(r,'端点或关系证据失效',[r.get('from'),r.get('to')]); continue
            if a['id']==b['id'] or not set(r['evidence'])&set(a['evidence']) or not set(r['evidence'])&set(b['evidence']):
                demote(r,'关系必须引用两个不同端点的证据');continue
            if a.get('role','main')!='main' or b.get('role','main')!='main':
                warnings.append(dict(id=r['id'],code='SIDE_RELATION',hint='旁支或上下文不串入主链；仅保留依据供回查'))
            if r.get('basis') in ('same_id','same_session'):
                container_relation=r['basis']=='same_session'
                def vals(ev):
                    candidates={(f['key'].lower(),f['norm']) for x in ev.get('evidence',[]) for f in evidence[x].get('fields',[]) if evidence[x]['status']=='supported' and id_kind(f['key']) in ('other','container') and distinctive(f['norm'])}
                    return {v for v in candidates if (id_kind(v[0])=='container' if container_relation else id_kind(v[0])=='other')}
                common=vals(a)&vals(b)
                r['idStats']=[dict(key=k,value=v,**id_stats(db,k,v)) for k,v in common]
                # Key AND value required; equal text in unrelated ID namespaces is not a join.
                if not common or not r.get('viaIds') or not all((v['key'].lower(),v['norm']) in common for v in r['viaIds']):
                    demote(r,'两端无同命名空间且相等的有效 ID')
            elif r.get('basis')=='time_order':
                ta,tb=a.get('time'),b.get('time')
                fa={evidence[x].get('fileId') for x in a.get('evidence',[])}; fb={evidence[x].get('fileId') for x in b.get('evidence',[])}
                if not ta or not tb or not ta.get('norm') or not tb.get('norm') or micros(ta['norm'])>=micros(tb['norm']):
                    demote(r,'缺少可信有序时间')
                elif fa!=fb:
                    demote(r,'跨文件时钟源未校验，不支持时间连线')
            else:
                demote(r,'未知关系依据；只允许 same_id/same_session/time_order')
        def zero_queries(qids,scope=None,patterns=None):
            qs=[query.get(x) for x in qids]
            if len(qs)<2 or not all(q and q['scanned']=='full' and q['matches']==0 and q['spec'].get('kind') in ('literal','regex') for q in qs) or sum(q['spec']['kind']=='literal' for q in qs)<2:
                return False
            values=[str(q['spec'].get('value','')).casefold() for q in qs]
            if len(set(values))!=len(values) or any(a in b or b in a for i,a in enumerate(values) for b in values[i+1:]):
                return False
            declared=[dict(scope=q['scope'],filters=q['spec'].get('filters',{})) for q in qs]
            if not scope or any(x!=scope for x in declared) or patterns!=[q['spec']['value'] for q in qs]:
                return False
            for q in qs:
                parent=query.get(q['spec'].get('anchorQueryId'))
                anchor=str(parent['spec'].get('value','')).casefold() if parent else ''
                if not parent or parent['spec'].get('kind') not in ('literal','count') or len(''.join(anchor.split()))<4 or anchor in ('true','false','null','none','info','debug','error','warn','undefined') or parent['matches']<=0 or parent['matches']>run['coverage']['scannedLines']/2 or parent['scope']!=q['scope'] or parent['spec'].get('filters',{})!=q['spec'].get('filters',{}) or not re.search(r'(?<!\w)'+re.escape(anchor)+r'(?!\w)',str(q['spec']['value']).casefold()):
                    return False
            return True
        def affected_losses(scope=None):
            scope=scope or {};selection=scope.get('scope','all');filters=scope.get('filters',{})
            fileset=None
            if isinstance(selection,dict):
                fileset=set(selection.get('files',[])) or None
                if selection.get('segments'):
                    segments=[s for s in run['segments'] if s['id'] in selection['segments']]
                    segfiles={s['fileId'] for s in segments}
                    fileset=segfiles if fileset is None else fileset & segfiles
            rng=filters.get('range')
            result=[]
            for x in run['coverage'].get('lossWindows',[]):
                if fileset is not None and x['fileId'] not in fileset:
                    continue
                domain=file_domain(files[x['fileId']])
                if rng and x['start'] and comparable(domain,value_domain(rng[0],str(rng[0]).startswith('2000-'))) and not (micros(x['start'])<=micros(rng[1]) and micros(x['end'])>=micros(rng[0])):
                    continue
                result.append(x)
            return result
        for h in hypotheses.values():
            h['validationStatus']='supported' if supported(h.get('for',[]),evidence) or supported(h.get('against',[]),evidence) else 'unsupported'
            if h.get('status')=='refuted' and not supported(h.get('against',[]),evidence):
                h['validationStatus']='unsupported'
            if h.get('status') in ('refuted','supported') and h['validationStatus']=='unsupported':
                h['claimedStatus']=h['status'];demote(h,'假设判定缺少有效支持/反证',h.get('for',[])+h.get('against',[]))
        for finding in report['findings']:
            finding['status']='supported'; supports=finding.get('supports',{})
            typ=finding.get('type')
            if typ not in ('fact','inference','gap','caution'):
                error(finding['id'],'TYPE','未知发现类型'); continue
            refs=supports.get('evidence',[])
            if any(x not in query for x in supports.get('queries',[])):
                demote(finding,'引用了不存在的检索记录',supports['queries'])
            deps=[(supports.get('events',[]),events),(supports.get('relations',[]),relations)]
            if any(rs and not supported(rs,reg) for rs,reg in deps) or (refs and not supported(refs,evidence)):
                demote(finding,'依赖证据/事件/关系失效',refs+supports.get('events',[])+supports.get('relations',[]))
            if any(x not in hypotheses or hypotheses[x]['validationStatus']!='supported' for x in supports.get('hypotheses',[])):
                demote(finding,'依赖假设未通过校验',supports['hypotheses'])
            if typ in ('fact','inference') and not supported(refs,evidence):
                demote(finding,'事实/推断需要直接有效证据')
            if typ=='gap' and not zero_queries(supports.get('queries',[]),finding.get('scope'),finding.get('patterns')):
                demote(finding,'缺失判断需要同一范围至少两种不同写法的全量零命中检索')
            if typ=='gap':
                finding['lossImpact']=affected_losses(finding.get('scope'))
                finding['lossSummary']=loss_summary(finding['lossImpact'])
                if finding['lossImpact']:
                    finding['strength']='possible';finding['qualification']='检索范围包含已知日志丢失，只能确认现存日志未命中，不能证明事件未发生。'

            if typ=='inference' and finding.get('strength') not in ('likely','possible'):
                error(finding['id'],'STRENGTH','推断必须标 likely/possible')
            if typ=='caution' and not refs and not supports.get('queries'):
                demote(finding,'注意项需要证据或检索记录')
            if typ in ('fact','inference') and CAUSE.search(finding.get('text','')) and report.get('diagnosis',{}).get('causeStatus') not in ('confirmed','likely'):
                demote(finding,'原因等级不足，不允许因果措辞')
            if typ in ('fact','inference','caution') and negative_fact(finding.get('text','')) and not any(query.get(q,{}).get('matches')==0 and query.get(q,{}).get('scanned')=='full' and query[q]['spec'].get('kind') in ('literal','regex','count') for q in supports.get('queries',[])):
                warnings.append(dict(id=finding['id'],code='NEGATIVE_FACT',hint='否定断言请核对检索依据；未观察到不等于未发生'))
        state=diagnosis.get('causeStatus')
        if state not in ('confirmed','likely','possible','undetermined','not_applicable'):
            error('diagnosis','CAUSE_STATUS','无效原因等级')
        missing=diagnosis.get('firstMissing',{})
        if missing:
            missing.pop('qualification',None)
            if not diagnosis.get('lastVisible') or not missing.get('expected') or not zero_queries(missing.get('queries',[]),missing.get('scope'),missing.get('patterns')):
                error('diagnosis.firstMissing','MISSING_EVIDENCE','缺失点须有最后可见点及多种锚定写法的全量零命中检索')
            missing['lossImpact']=affected_losses(missing.get('scope'));missing['lossSummary']=loss_summary(missing['lossImpact'])
            if missing['lossImpact']: missing['qualification']='现存日志未命中；范围包含已知丢失，不能证明事件未发生。'
        if state=='undetermined' and (not diagnosis.get('lastVisible') or not missing or not diagnosis.get('insufficiency') or not diagnosis.get('suggestions')):
            error('diagnosis','INSUFFICIENT','原因未定须给最后可见点、缺失点、不足类别和补充建议')
        if CAUSE.search(report.get('title','')) and state not in ('confirmed','likely'):
            report['unverifiedTitle']=report['title'];report['title']='日志分析';demoted.append(dict(id='title',reason='标题因果断言未获原因等级支持'))
        for name,ext in report.get('extensions',{}).items():
            if '@' not in name:
                error('extensions','NAMESPACE','扩展须带版本命名空间')
            for s in ext.get('states',[]):
                s['status']='supported' if supported(s.get('evidence',[]),evidence) else 'unsupported'
                if state not in ('confirmed','likely') and CAUSE.search(str(s.get('value',''))):
                    s['status']='unsupported'
                if s['status']=='unsupported':
                    demoted.append(dict(id=s.get('key'),reason='扩展状态证据失效',cascadeFrom=s.get('evidence')))
        if not any(x.get('status')=='supported' for x in report['findings']):
            error('findings','NO_CONCLUSION','没有任何通过的发现；结论未获证据支持')
        if len(evidence)>150:
            warnings.append(dict(code='EVIDENCE_VOLUME',hint='证据超过150条，建议聚焦'))
    finally:
        db.close()
    report.update(input=dict(sources=run['sources'],files=run['files'],excluded=run['excluded'],project=run['project']),decisions=run['decisions'],segments=run['segments'],coverage=run['coverage'],histogram=run.get('histogram',[]),queries=run['queries'])
    report['coverage']=copy.deepcopy(report['coverage']);report['coverage']['lossSummary']=loss_summary(run['coverage'].get('lossWindows',[]))
    passed=[x for x in report['findings'] if x.get('status')=='supported']
    primary=next((x for x in passed if x['type']=='fact'),next((x for x in passed if x['type']=='inference'),None))
    report['conclusion']=dict(type=primary['type'] if primary else 'summary',text=primary['text'] if primary else '已整理日志范围与证据；尚无通过校验的事实结论。',causeStatus=report.get('diagnosis',{}).get('causeStatus'),missing=report.get('diagnosis',{}).get('firstMissing'))
    report['verdict']=report['conclusion']
    validation=dict(status='fail' if errors else 'pass_with_demotions' if demoted else 'pass',errors=errors,demoted=demoted,warnings=warnings,disclaimer='机械校验只证明引用和结构一致，不证明语义因果。')
    report['validation']=validation
    return report,validation


def check(args):
    run=load(args.run);draft=read(args.draft)
    try:
        report,validation=check_report(run,draft,full_hash=False)
    except (TypeError,AttributeError,KeyError,ValueError) as e:
        report=draft if isinstance(draft,dict) else {};validation=dict(status='fail',errors=[dict(code='STRUCTURE',path='draft',hint=str(e))],demoted=[],warnings=[])
    write(Path(run['workDir'])/'checked.json',report);write(Path(run['workDir'])/'validation.json',validation)
    run['stage']='checked';run['draft']=str(Path(args.draft).resolve());save(run)
    return dict(ok=validation['status']!='fail',**validation,next='修复后check或render')
