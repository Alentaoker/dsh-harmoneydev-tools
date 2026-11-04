import json
from pathlib import Path

from .core import ROOT, clean_work, load, now, read, write,save
from .model import check_report
from .index import search
from argparse import Namespace


def html(report):
    data=json.dumps(report,ensure_ascii=False).replace('<','\\u003c').replace('\u2028','\\u2028').replace('\u2029','\\u2029')
    return (ROOT/'assets/report-template.html').read_text(encoding='utf-8').replace('/*__REPORT__*/',data)


def render(args):
    run=load(args.run)
    checked=Path(run['workDir'])/'checked.json'
    if not checked.exists():
        raise ValueError('先 check')
    # Recheck at publication, not merely trust a previously passed file.
    draft=read(run['draft'])
    report,validation=check_report(run,draft)
    if validation['status']=='fail':
        write(Path(run['workDir'])/'validation.json',validation)
        return dict(ok=False,**validation)
    referenced=set(report.get('diagnosis',{}).get('firstMissing',{}).get('queries',[]))
    for item in report['findings']:
        if item.get('type') in ('gap','caution'):
            referenced.update(item.get('supports',{}).get('queries',[]))
    for q in run['queries']:
        if q['id'] in referenced and q['spec'].get('anchorQueryId'):
            referenced.add(q['spec']['anchorQueryId'])
    for q in list(run['queries']):
        if q['id'] in referenced and q['spec'].get('kind') in ('literal','regex','count'):
            replay=search(Namespace(run=run['run'],spec=json.dumps(q['spec']),no_cache=True,replay=True))['query']
            if replay['matches']!=q['matches']:
                return dict(ok=False,status='fail',errors=[dict(code='QUERY_REPLAY',path=q['id'],hint='检索或存在性锚点重放结果发生变化')])
    run=load(run['run']);report,validation=check_report(run,draft,full_hash=False)
    if validation['status']=='fail':
        return dict(ok=False,**validation)
    report['generatedAt']=now()
    report['cleanup']=dict(status='kept' if args.keep_work else 'pending',freedBytes=0,leftovers=[run['workDir']],at=now())
    out=Path(run['out'])
    # Publish a self-contained report first. Cleanup failure cannot lose evidence.
    write(out/'report.json',report); write(out/'validation.json',validation)
    (out/'report.html').write_text(html(report),encoding='utf-8')
    if not args.keep_work:
        try:
            report['cleanup']=clean_work(run)
            (out/'.ula-owner').unlink()
        except (OSError,ValueError) as e:
            report['cleanup']=dict(status='failed',freedBytes=0,leftovers=[run['workDir']],error=str(e),at=now())
        write(out/'report.json',report)
        (out/'report.html').write_text(html(report),encoding='utf-8')
    return dict(ok=True,report=str(out/'report.html'),validation=validation['status'],cleanup=report['cleanup'])
