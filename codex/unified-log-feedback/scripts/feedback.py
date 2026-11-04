"""Explicit, local-only feedback packaging. Standard library; no transport."""
import argparse,collections,datetime,getpass,hashlib,ipaddress,json,os,platform,re,socket,sys
from pathlib import Path

VERSION='0.2.0-beta.1'
NOTICE='脱敏不保证完整，请检查后再发送；映射文件不要外发。'
NAME_NOTICE='默认规则不识别产品、项目、公司、人名和内部模块名；请先补充敏感词并人工检查。'
CATEGORIES=['missed_evidence','misread','fabricated_cause','wrong_cause_level','wrong_question_or_type','log_insufficient_unstated','noise','tool_blocked_valid','tool_passed_invalid','parsing','readability','performance','other']
STAGES=['question','input_selection','search','log_reading','cause_grading','tool_rule','parser','report_ui','log_content','unknown']


def read(p):
    return json.loads(Path(p).read_text(encoding='utf-8-sig'))


def obj(x): return x if isinstance(x,dict) else {}
def arr(x): return x if isinstance(x,list) else []


def template():
    return dict(actual='',deviation='',expected='',userConfirmed=False,categories=[],suspectedStage='unknown',severity='medium',aiSelfReview='',suggestion='',excerpts=[])


class Redactor:
    def __init__(self,terms=()):
        self.mapping={};self.reverse={};self.counts=collections.Counter();self.counters=collections.Counter()
        self.terms={t.strip() for t in terms if isinstance(t,str) and t.strip()}
        automatic={t.strip() for t in (getpass.getuser(),socket.gethostname()) if len(t.strip())>=3}
        self.patterns={t:self.pattern(t,bool(re.fullmatch(r'[A-Za-z0-9]+',t))) for t in self.terms}
        for t in automatic: self.patterns.setdefault(t,self.pattern(t,True))

    @staticmethod
    def pattern(value,bounded=False):
        return re.compile((r'(?<![A-Za-z0-9_])' if bounded else '')+re.escape(value)+(r'(?![A-Za-z0-9_])' if bounded else ''),re.I)

    def replace(self,value,kind):
        if re.fullmatch(r'<[A-Z]+-\d+>',value): return value
        self.counts[kind]+=1
        if value not in self.reverse:
            self.counters[kind]+=1;token='<'+kind+'-'+str(self.counters[kind])+'>';self.reverse[value]=token;self.mapping[token]=value
        return self.reverse[value]

    def text(self,text):
        s=str(text)
        for term in sorted(self.patterns,key=lambda t:(-len(t),t)):
            s=self.patterns[term].sub(lambda m:self.replace(m[0],'TERM'),s)
        secret=re.compile(r'''\b(password|passwd|token|secret|api[_ -]?key|cookie|authorization)(["']?\s*[:=]\s*["']?)((?:Bearer\s+)?[^\s"',;}\]]+)''',re.I)
        s=secret.sub(lambda m:m[1]+m[2]+self.replace(m[3],'SECRET'),s)
        s=re.sub(r'\bBearer\s+[^\s"\x27,;}]+',lambda m:self.replace(m[0],'SECRET'),s,flags=re.I)
        s=re.sub(r'\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+',lambda m:self.replace(m[0],'SECRET'),s)
        rules=[('EMAIL',r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b'),('URL',r'https?://[^\s"\x27<>]+'),('PATH',r'(?:[A-Za-z]:[\\/]|\\\\)[^\r\n"\x27;,]*|(?<![\w:/])/(?:[^\s/"\x27<>]+/)+[^\s"\x27<>;,]*'),('UUID',r'\b[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}\b'),('MAC',r'\b(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}\b'),('IP',r'\b(?:\d{1,3}\.){3}\d{1,3}\b'),('PERSON',r'(?<!\d)\d{17}[\dXx](?!\d)'),('PHONE',r'(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)')]
        for kind,pattern in rules:s=re.sub(pattern,lambda m:self.replace(m[0],kind),s)
        def ipv6(m):
            v=m[0]
            if '::' not in v and v.count(':')<4:return v
            try:ipaddress.IPv6Address(v)
            except ValueError:return v
            return self.replace(v,'IP')
        s=re.sub(r'(?<![\w:])(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}(?![\w:])',ipv6,s)
        def identifier(m):
            key=m[1];value=m[3]
            if key.casefold() in ('pid','tid','ppid','valid','invalid','paid') or len(value)<4 or value.casefold() in ('true','false','null'):return m[0]
            return key+m[2]+self.replace(value,'ID')
        s=re.sub(r'''\b([A-Za-z_][A-Za-z0-9_]*(?:Id|ID|_id|uuid|imei|serial|account|user|phone|mobile)|id|uuid|imei|serial|account|user|phone|mobile)(["']?\s*[:=]\s*["']?)([^\s"',;}\]<>]+)''',identifier,s,flags=re.I)
        for kind,pattern in [('TOKEN',r'\b(?=[a-fA-F0-9]{12,}\b)(?=[a-fA-F0-9]*\d)[a-fA-F0-9]+\b'),('TOKEN',r'\b(?=[A-Za-z0-9_./+=-]{16,}\b)(?=[A-Za-z0-9_./+=-]*\d)[A-Za-z0-9_./+=-]+\b'),('NUMBER',r'(?<!\d)\d{8,}(?!\d)'),('TOKEN',r'(?<!\w)[A-Za-z0-9+/]{32,}={0,2}(?!\w)'),('PACKAGE',r'\b(?:com|cn|org|net|io)\.(?:[A-Za-z_][A-Za-z0-9_]*\.)*[A-Za-z_][A-Za-z0-9_]*')]:
            s=re.sub(pattern,lambda m:self.replace(m[0],kind),s)
        # A value first discovered by a keyed rule may occur elsewhere without its key.
        for value,token in sorted(self.reverse.items(),key=lambda x:-len(x[0])):
            pattern=next((p for t,p in self.patterns.items() if t.casefold()==value.casefold()),None)
            if pattern is None and len(value)<6:continue
            s=(pattern or self.pattern(value,True)).sub(lambda m:token,s)
        return s

    def sanitize(self,value,key=''):
        if isinstance(value,dict):return {k:self.sanitize(v,k) for k,v in value.items()}
        if isinstance(value,list):return [self.sanitize(v,key) for v in value]
        if isinstance(value,str):
            if key in ('sourceHash','packageHash','scriptHash') and re.fullmatch('[0-9a-f]{64}',value):return value
            return self.text(value)
        if isinstance(value,(int,float)) and str(value) in self.terms:return self.replace(str(value),'TERM')
        return value


def truncate(value):
    if isinstance(value,dict):return {k:truncate(v) for k,v in value.items()}
    if isinstance(value,list):return [truncate(v) for v in value]
    return value[:600] if isinstance(value,str) else value


def remaining(value):
    counts=collections.Counter()
    def visit(x):
        if isinstance(x,dict):
            for v in x.values():visit(v)
        elif isinstance(x,list):
            for v in x:visit(v)
        elif isinstance(x,str):
            text=re.sub(r'<[A-Z]+-\d+>',' ',x)
            counts.update(re.findall(r'\b(?:[A-Za-z][A-Za-z0-9]*[._][A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*|[A-Za-z]*[a-z][A-Z][A-Za-z0-9]*)\b',text))
    visit(value)
    return sorted(counts,key=lambda name:(-counts[name],name))


def scan_text(text,terms=()):
    red=Redactor(terms);red.text(text)
    return dict(count=sum(red.counts.values()),types=dict(red.counts))


def report_summary(report,no_quotes=False):
    q=obj(report.get('question'));d=obj(report.get('diagnosis'));c=obj(report.get('conclusion'));v=obj(report.get('validation'));cov=obj(report.get('coverage'));build=obj(report.get('build'));evidence={e.get('id'):e for e in arr(report.get('evidence')) if isinstance(e,dict)}
    events=[];used=[];start=None
    for event in arr(report.get('events')):
        if not isinstance(event,dict):continue
        ts=obj(event.get('time')).get('norm');offset=None
        try:
            current=datetime.datetime.fromisoformat(ts.replace('Z','+00:00'))
            if start is None:start=current
            offset=(current-start).total_seconds()
        except (ValueError,TypeError,AttributeError):pass
        refs=[]
        for eid in arr(event.get('evidence')):
            e=obj(evidence.get(eid));ref=e.get('ref');refs.append(ref.split('#')[0] if isinstance(ref,str) else None)
            if event.get('role','main')=='main':used.append(eid)
        events.append(dict(id=event.get('id'),role=event.get('role','main'),status=event.get('status'),title=event.get('title'),offsetSeconds=offset,positions=refs))
    used+=arr(obj(d.get('cause')).get('evidence'))+[d.get('lastVisibleLine')]
    quotes=[]
    if not no_quotes:
        for eid in dict.fromkeys(x for x in used if isinstance(x,str)):
            e=obj(evidence.get(eid))
            if e.get('status')=='supported':quotes.append(dict(ref=str(e.get('ref','')).split('#')[0],text=e.get('quote')))
            if len(quotes)>=30:break
    queries=[dict(kind=obj(x.get('spec')).get('kind'),scope=x.get('scope'),value=obj(x.get('spec')).get('value'),matches=x.get('matches'),purpose=x.get('purpose'),seconds=x.get('seconds')) for x in arr(report.get('queries'))[:100] if isinstance(x,dict)]
    templates=arr(obj(d.get('neighborhood')).get('anomalyTemplates'))[:15]
    if no_quotes:templates=[{k:t.get(k) for k in ('id','count','priority','rate','firstInNeighborhood','discussed')} for t in templates if isinstance(t,dict)]
    files=[{k:f.get(k) for k in ('id','lineCount','format','parseRate','clockDomain','encoding','encodingConfidence')} for f in arr(obj(report.get('input')).get('files')) if isinstance(f,dict)]
    return dict(identity=dict(schemaVersion=report.get('schemaVersion'),sourceHash=build.get('sourceHash'),packageHash=build.get('packageHash'),host=build.get('host')),question=q,conclusion=dict(text=c.get('text'),aiCause=obj(d.get('causeAssessment')).get('ai'),checkedCause=d.get('causeStatus'),validation=v.get('status'),errors=[obj(x).get('code') for x in arr(v.get('errors'))],warnings=[obj(x).get('code') for x in arr(v.get('warnings'))],demotions=len(arr(v.get('demoted')))),chain=events,quotes=quotes,diagnosis={k:d.get(k) for k in ('lastVisible','lastVisibleLine','firstMissing','insufficiency','suggestions','cause')},findings=arr(report.get('findings')),hypotheses=arr(report.get('hypotheses')),neighborhood=dict(matches=obj(d.get('neighborhood')).get('matches'),templates=templates),queries=queries,scope=dict(files=files,lines=cov.get('lines'),loss=obj(cov.get('lossSummary')),templates=cov.get('templates')),environment=dict(os=platform.system(),python=platform.python_version(),scanSeconds=cov.get('scanSeconds'),querySeconds=sum(float(x.get('seconds') or 0) for x in queries)))


def build(args):
    path=Path(args.report).resolve()
    if path.is_dir():path=path/'report.json' if (path/'report.json').exists() else path/'work/checked.json'
    report=obj(read(path));feedback=obj(read(args.input))
    if not all(isinstance(feedback.get(k),str) and feedback[k].strip() for k in ('actual','deviation')):raise ValueError('actual和deviation须填写用户所述的实际情况与偏差')
    if any(c not in CATEGORIES for c in arr(feedback.get('categories'))):raise ValueError('无效反馈类别')
    if feedback.get('suspectedStage','unknown') not in STAGES or feedback.get('severity','medium') not in ('critical','high','medium','low'):raise ValueError('无效环节或严重度')
    if len(arr(feedback.get('excerpts')))>20:raise ValueError('excerpts最多20条')
    if args.no_quotes:feedback=dict(feedback,excerpts=[])
    terms=Path(args.extra_terms).read_text(encoding='utf-8-sig').splitlines() if args.extra_terms else []
    red=Redactor(terms)
    payload=dict(schemaVersion='ula-feedback/1',feedbackSkill=dict(version=VERSION,scriptHash=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()),report=report_summary(report,args.no_quotes),feedback={k:feedback.get(k) for k in template()})
    # Discover all values first, then apply globally for consistency across fields.
    red.sanitize(payload);sanitized=red.sanitize(payload)
    residual=scan_text(json.dumps(sanitized,ensure_ascii=False),terms)
    payload=truncate(sanitized);payload['redaction']=dict(replacements=dict(red.counts),residualRiskCounts=residual,notice=NOTICE)
    label='ula-feedback-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    destination=Path(args.out).resolve() if args.out else path.parent/'feedback'/label
    local_dir=destination.with_name(destination.name+'-LOCAL-ONLY')
    if destination.exists() or local_dir.exists():raise FileExistsError('输出目录或本地映射目录已存在，请使用新目录')
    destination.mkdir(parents=True,exist_ok=False);local_dir.mkdir(parents=True,exist_ok=False)
    share=destination/(label+'.json');md=destination/(label+'.md');local=local_dir/(label+'.LOCAL-ONLY-mapping.json')
    text=json.dumps(payload,ensure_ascii=False,indent=2)
    share.write_text(text+'\n',encoding='utf-8')
    # Markdown contains a readable summary; raw values never become links or markup.
    def safe(value):
        s=str(value if value is not None else '未填写').replace('&','&amp;').replace('<','&lt;').replace('>','&gt;')
        return re.sub(r'([\\`*_\[\]#|])',r'\\\1',s)
    f=payload['feedback'];r=payload['report'];parts=['# 日志分析反馈',NOTICE,NAME_NOTICE,'## 用户说明','实际情况：'+safe(f.get('actual')),'报告偏差：'+safe(f.get('deviation')),'期望结论：'+safe(f.get('expected')),'## 报告摘要',safe(obj(r.get('question')).get('raw')),safe(obj(r.get('conclusion')).get('text')),'原因等级：'+safe(obj(r.get('conclusion')).get('checkedCause')),'## AI 复盘',safe(f.get('aiSelfReview')),'建议：'+safe(f.get('suggestion')),'## 关键链路']
    parts.extend('- '+safe(e.get('title'))+' · '+safe(e.get('role'))+' · '+safe('、'.join(str(x) for x in e.get('positions',[]))) for e in r.get('chain',[]))
    parts+=['## 脱敏情况',safe(payload['redaction']['replacements']),'剩余风险计数：'+safe(residual),'完整结构见同名 JSON；LOCAL-ONLY 映射文件只留本机。']
    md.write_text('\n\n'.join(parts)+'\n',encoding='utf-8')
    identifiers=remaining(payload)
    local.write_text(json.dumps(dict(localOnly=True,mapping=red.mapping,remainingIdentifiers=identifiers),ensure_ascii=False,indent=2),encoding='utf-8')
    return dict(ok=True,share=[str(share),str(md)],localOnly=str(local),redactions=dict(red.counts),residualRiskCounts=residual,remainingIdentifierCount=len(identifiers),remainingIdentifiers=identifiers[:40],warnings=([NOTICE,NAME_NOTICE]+(['用户尚未确认实际情况，请确认后再分享'] if feedback.get('userConfirmed') is not True else [])))


def main():
    if hasattr(sys.stdout,'reconfigure'):sys.stdout.reconfigure(encoding='utf-8')
    p=argparse.ArgumentParser(description='显式调用、离线生成脱敏反馈；不发送。');sub=p.add_subparsers(dest='command',required=True)
    sub.add_parser('template');b=sub.add_parser('build');b.add_argument('--report',required=True);b.add_argument('--input',required=True);b.add_argument('--extra-terms');b.add_argument('--no-quotes',action='store_true');b.add_argument('--out');s=sub.add_parser('scan');s.add_argument('--file',required=True)
    try:
        args=p.parse_args()
        result=dict(ok=True,input=template(),fields=dict(categories=CATEGORIES,stages=STAGES)) if args.command=='template' else dict(ok=True,**scan_text(Path(args.file).read_text(encoding='utf-8-sig'))) if args.command=='scan' else build(args)
        print(json.dumps(result,ensure_ascii=False))
    except (ValueError,OSError,TypeError,KeyError) as e:
        print(json.dumps(dict(ok=False,error=type(e).__name__,hint=str(e)),ensure_ascii=False));sys.exit(1)


if __name__=='__main__':main()
