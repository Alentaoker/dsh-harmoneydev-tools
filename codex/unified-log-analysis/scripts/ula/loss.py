"""Summaries of explicit loss markers; counts are reported, not reconstructed events."""
from .storage import parse_datetime,micros
from .clocks import value_domain,comparable


def summary(items,center=None):
    groups=[]
    domain=lambda x:x.get('clockDomain') or value_domain(x['start'],x['start'].startswith('2000-'))
    timed=sorted((x for x in items if x.get('start') and x.get('end')),key=lambda x:(x.get('fileId',''),domain(x),micros(x['start'])))
    for item in timed:
        if groups and item.get('fileId')==groups[-1].get('fileId') and domain(item)==groups[-1]['clockDomain'] and micros(item['start'])<=micros(groups[-1]['end'])+50000:
            groups[-1]['end']=max((groups[-1]['end'],item['end']),key=micros);groups[-1]['count']+=item['count'];groups[-1]['markers']+=1
        else:
            groups.append(dict(fileId=item.get('fileId'),clockDomain=domain(item),start=item['start'],end=item['end'],count=item['count'],markers=1))
    def distance(item):
        try:
            if not comparable(domain(item),value_domain(center,center.startswith('2000-'))):
                return float('inf')
            return abs((parse_datetime(item['end'])-parse_datetime(center)).total_seconds())
        except TypeError:
            return float('inf')
    nearest=min(timed,key=distance) if center and timed else None
    if nearest and distance(nearest)==float('inf'):
        nearest=None
    return dict(markers=len(items),reportedDroppedLines=sum(x['count'] for x in items),mergedIntervals=groups,nearest=nearest,countBasis='显式丢失标记报告值的和；跨文件重复标记及跨设备时钟尚未独立核实，非重建事件数。')
