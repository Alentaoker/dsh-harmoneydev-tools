import argparse
import json
from pathlib import Path
import sys

from . import core, index, model, render


class JsonParser(argparse.ArgumentParser):
    def error(self,message):
        raise ValueError(message)


def parser():
    p=JsonParser(description='显式调用的独立日志分析工具；无网络、无模型循环。')
    sub=p.add_subparsers(dest='command',required=True)
    sub.add_parser('guide')
    s=sub.add_parser('start');s.add_argument('--log',nargs='+',required=True);s.add_argument('--question');s.add_argument('--out');g=s.add_mutually_exclusive_group();g.add_argument('--project');g.add_argument('--project-cwd',action='store_true');s.add_argument('--ext',action='append')
    s.add_argument('--question-type',choices=['triage','existence','failure','crash','latency'])
    s.add_argument('--problem-window',nargs=2)
    q=sub.add_parser('question');q.add_argument('--run',required=True);q.add_argument('--question');q.add_argument('--question-type',choices=['triage','existence','failure','crash','latency']);q.add_argument('--problem-window',nargs=2)
    for cmd in ('scan','status','clean'):
        sub.add_parser(cmd).add_argument('--run',required=True)
    s=sub.add_parser('files');s.add_argument('--run',required=True);s.add_argument('action',choices=['add','drop']);s.add_argument('--path');s.add_argument('--from',dest='source',required=True);s.add_argument('--reason',required=True)
    s=sub.add_parser('extract');s.add_argument('--run',required=True);s.add_argument('--file',required=True);s.add_argument('--members',nargs='+');s.add_argument('--reason',required=True)
    s=sub.add_parser('segment');s.add_argument('--run',required=True);s.add_argument('--by',choices=['auto','session','time','size'],default='auto');s.add_argument('--window',type=float,default=600,help='秒');s.add_argument('--size',type=int,default=100*1024**2,help='字节');s.add_argument('--reason');s.add_argument('--deep',nargs='+')
    s.add_argument('--problem-window',nargs=2)
    s=sub.add_parser('search');s.add_argument('--run',required=True);g=s.add_mutually_exclusive_group(required=True);g.add_argument('--spec',help='JSON');g.add_argument('--spec-file')
    s=sub.add_parser('check');s.add_argument('--run',required=True);s.add_argument('--draft',required=True)
    s=sub.add_parser('render');s.add_argument('--run',required=True);s.add_argument('--keep-work',action='store_true')
    s=sub.add_parser('legacy');s.add_argument('--report',required=True);s.add_argument('--out',required=True)
    return p


def dispatch(args):
    if args.command=='guide':
        entry=core.ROOT/'SKILL.md'
        if not entry.exists():
            entry=core.ROOT/'MANUAL.md'
        return dict(ok=True,version=core.VERSION,skill=entry.read_text(encoding='utf-8'),guide=(core.ROOT/'references/analysis-guide.md').read_text(encoding='utf-8'),draft=model.empty_draft())
    if args.command=='status':
        p=Path(args.run)
        if p.is_dir() and (p/'report.json').exists() and not (p/'work').exists():
            report=core.read(p/'report.json')
            return dict(ok=True,stage='rendered',cleanup=report['cleanup'],next='打开 report.html；重新分析需 start')
        run=core.load(args.run)
        return dict(ok=True,stage=run['stage'],workDir=run['workDir'],workBytes=sum(p.stat().st_size for p in Path(run['workDir']).rglob('*') if p.is_file()),next='依据 stage 续跑，或 clean')
    if args.command=='clean':
        run=core.load(args.run);cleanup=core.clean_work(run)
        out=Path(run['out'])
        if (out/'report.json').exists():
            r=core.read(out/'report.json');r['cleanup']=cleanup;core.write(out/'report.json',r);(out/'report.html').write_text(render.html(r),encoding='utf-8')
        (out/'.ula-owner').unlink(missing_ok=True)
        return dict(ok=True,cleanup=cleanup)
    if args.command=='search' and args.spec_file:
        args.spec=Path(args.spec_file).read_text(encoding='utf-8-sig')
    if args.command=='legacy':
        from .legacy import legacy
        return legacy(args)
    fn={'start':core.start,'question':core.question,'files':core.files,'extract':core.extract,'scan':index.scan,'segment':index.segment,'search':index.search,'check':model.check,'render':render.render}[args.command]
    return fn(args)


def main():
    if hasattr(sys.stdout,'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    try:
        result=dispatch(parser().parse_args())
        print(json.dumps(result,ensure_ascii=False))
        sys.exit(0 if result.get('ok',True) else 2)
    except (ValueError,OSError,KeyError,json.JSONDecodeError) as e:
        print(json.dumps(dict(ok=False,error=type(e).__name__,hint=str(e)),ensure_ascii=False));sys.exit(1)
    except Exception as e:
        print(json.dumps(dict(ok=False,error=type(e).__name__,hint=str(e)),ensure_ascii=False));sys.exit(3)
