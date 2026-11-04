from argparse import Namespace
from pathlib import Path

from . import core,index,model,render


def legacy(args):
    old=core.read(args.report); source=old.get('source',{}); path=Path(source.get('path',''))
    if old.get('schemaVersion') not in ('1.0','1'):
        raise ValueError('只读兼容仅支持旧schema1.0')
    draft=model.empty_draft();draft['title']=old.get('title','旧报告')+' · 只读迁移'
    draft['legacy']=dict(reportHash=core.digest(args.report),summary=old.get('summary'),notice='旧关系依据未标注，不将旧结论当作新分析通过项。')
    if not path.is_file():
        out=Path(args.out)
        if out.exists():
            raise ValueError('迁移输出目录必须不存在')
        out.mkdir(parents=True)
        draft.update(input=dict(sources=[source],files=[],excluded=[],project=None),coverage=dict(files=0,lines=0,time=dict(available='none')),segments=[],queries=[],decisions=[],cleanup=dict(status='cleaned',freedBytes=0,leftovers=[]),validation=dict(status='fail',errors=[dict(code='UNAVAILABLE',hint='证据不可复核')],demoted=[],warnings=[]))
        draft['findings']=[dict(id='legacy-notice',type='caution',text='原始日志不可得，旧报告证据不可复核。',status='supported',supports={})]
        core.write(out/'report.json',draft);core.write(out/'validation.json',draft['validation']);(out/'report.html').write_text(render.html(draft),encoding='utf-8')
        return dict(ok=True,report=str(out/'report.html'),validation='fail',notice='只读展示，非通过校验')
    result=core.start(Namespace(log=[str(path)],out=args.out,question=None,project=None,project_cwd=False,ext=[]));run=core.load(result['run'])
    core.add_file(run,path,run['sources'][0],'旧报告迁移，独立副本');core.save(run)
    index.scan(Namespace(run=run['run']));run=core.load(run['run']);db=core.connect(run)
    try:
        for e in old.get('evidence',[]):
            row=db.execute('SELECT * FROM lines WHERE file=? AND n=?',('F1',e['line'])).fetchone()
            draft['evidence'].append(dict(id=e['id'],ref=index.line(run,row)['ref'] if row else 'invalid',quote=e['quote'],fields=[]))
    finally:
        db.close()
    for node in old.get('nodes',[]):
        draft['events'].append(dict(id=node['id'],title=node['title'],detail=node.get('explanation',''),lane=node.get('actor','旧报告'),role='main',time=dict(raw=node['time']) if node.get('time') else None,evidence=node.get('evidenceIds',[])))
    for i,edge in enumerate(old.get('edges',[]),1):
        draft['relations'].append(dict(id='legacy-relation-'+str(i),**{'from':edge['from'],'to':edge['to']},basis='legacy',detail=edge.get('basis'),evidence=edge.get('evidenceIds',[])))
    draft['findings']=[dict(id='legacy-audit',type='fact',text='旧报告已只读迁移，证据按原始日志重新核对；旧关系依据未标注，不能据此推导因果。',supports={'evidence':[e['id'] for e in draft['evidence']]})]
    file=Path(run['workDir'])/'legacy-draft.json';core.write(file,draft);check=model.check(Namespace(run=run['run'],draft=str(file)))
    if not check['ok']:
        return check
    return render.render(Namespace(run=run['run'],keep_work=False))
