import datetime as dt
import re
from .storage import encode_datetime

HILOG = re.compile(r'^(\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)\s+(\d+)\s+(\d+)\s+([A-Z])\s+(.+?):\s+(.*)$')
HILOG_COMPACT = re.compile(r'^(\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)\s+(\d+)\s+(\d+)\s+([A-Z])\s+(.+?):(.*)$')
ISO = re.compile(r'^\[?(\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:[.,]\d+)?(?:\s*(?:Z|[+-]\d\d(?::?\d\d)?))?)\]?\s*(.*)$')
IDS = re.compile(r'\b([A-Za-z_][A-Za-z_0-9]*)\s*["\x27]?\s*[:=]\s*["\x27]?([\w.:-]+)')
ID_KEY = re.compile(r'\b([A-Za-z_][A-Za-z_0-9]*)\s*["\x27]?\s*[:=]\s*')
ID_VALUE = re.compile(r'["\x27]?([\w.:-]+)')
TRACE = re.compile(r'\[([0-9a-fA-F]{8,32}) ([0-9a-fA-F]{1,32}) ([0-9a-fA-F]{1,32})\]')
LIFECYCLE=re.compile(r'\b(?:boot completed|process started|application started|restarting|Application onCreate|Ability onCreate)\b|进程重启|进程启动|应用启动|开机完成|应用生命周期启动',re.I)
LOSS_CONTEXT=re.compile(r'\bLOGS OVER (?:PROC )?QUOTA\b|\bLOGLIMIT\b',re.I)
LOSS_TIMED=re.compile(r'(\d+)\s+DROPPED.*?from time:\s*(\d{4}-\d\d-\d\d [\d:.]+)\s+to time:\s*(\d{4}-\d\d-\d\d [\d:.]+)',re.I)
LOSS_COUNT=re.compile(r'\b(\d+)\s+DROPPED\b',re.I)
LOSS_NAMED=re.compile(r'(?:\bchatty\b.*?\bexpire\b|\blogs?\s+lost\b\s*[:=]?)\s*(\d+)\s*(?:lines)?',re.I)
CAMEL=re.compile(r'([a-z0-9])([A-Z])')
CODE=re.compile(r'\b((?:(?:ret|err|error|result|status)\s*)?code|errno|ret|result)\s*["\x27]?\s*(?:[:=]|is)\s*([+-]?\d+)\b',re.I)
EMPTY_STATE=re.compile(r'\b(?:is\s*)?(?:cancel(?:led|ed)?|fail(?:ed|ure)?|error)\s*["\x27]?\s*[:=]\s*(?:false|null|none|undefined|0|""|\x27\x27)(?!\w)',re.I)
COUNTER_ZERO=re.compile(r'\b\w*(?:error|fail|failure|timeout|cancel)\w*\s*(?:count|num|times)\s*["\x27]?\s*[:=]\s*0\b|(?:错误|失败|超时|取消)(?:码|次数|数量|计数)\s*[:：=]\s*0\b',re.I)
TIMEOUT_SETTING=re.compile(r'\btimeout\s*(?:ms|millis|milliseconds|s|sec|seconds)?\s*["\x27]?\s*[:=]\s*\d+(?:\.\d+)?\s*(?:ms|s|sec|seconds)?\b',re.I)
FAILURE_WORDS=re.compile(r'失败|异常|超时|错误|断开|拒绝|崩溃|不可达|溢出|\b(?:fail(?:ed|ure|ures|ing)?|error|timeout|cancel(?:led|ed)?|abort\w*|exception|disconnect(?:ed|ion)?|refus\w*|died|kill\w*|anr|oom|denied|invalid|not found|unavailable|crash(?:ed)?|fatal|panic|reject\w*|lost|expir\w*|exceed\w*|overflow|unauthorized|forbidden|unreachable)\b',re.I)
T_PATH=re.compile(r'https?://\S+|(?:[A-Za-z]:\\|/)[\w/\\.:-]+')
T_UUID_IP=re.compile(r'\b[0-9a-fA-F]{8}-[0-9a-fA-F-]{20,}\b|\b(?:\d{1,3}\.){3}\d{1,3}\b')
T_HEX=re.compile(r'\b[0-9a-fA-F]{8,}\b')
T_DIGITS=re.compile(r'[+-]?\d+(?:\.\d+)?')
T_QUOTES=re.compile(r'(["\x27])([^"\x27\n]{16,})\1(?!\s*:)')
T_LABEL=re.compile(r'[a-zA-Z_]{1,40}')
T_MASKED=re.compile(r'[\w.-]*\*{2,}[\w*.-]*')
T_PAYLOAD=re.compile(r'[A-Za-z0-9+/=_-]{80,}')
T_CODE=re.compile(r'\b((?:[a-z_]\w*(?:code|errno)|code|errno|ret|result)\s*["\x27]?\s*[:=]\s*)([+-]?\d+)',re.I)


def id_kind(key):
    base=key.replace('_','').lower().removesuffix('id')
    if base in ('user','device','agent','p','t','u','android','account'):
        return 'entity'
    if base in ('session','conversation','dialog','page'):
        return 'container'
    return 'other'


def id_key(key):
    return key.lower() in ('id','uuid') or key.endswith(('Id','ID','_id'))


def distinctive(value):
    return len(value)>=6 and value.lower() not in ('true','false','null','undefined') and not (value.isdigit() and int(value)<1000000)


def extract_ids(message):
    result=[]
    for match in ID_KEY.finditer(message):
        key=match[1]
        if not id_key(key): continue
        value=ID_VALUE.match(message,match.end())
        raw=value[1] if value else ''
        if value and re.match(r'\s*["\x27]?\s*[:=]',message[value.end():]): raw=''
        normalized=raw.rstrip('.:')
        result.append(dict(key=key,raw=raw,norm=normalized,rule='id_punctuation' if raw!=normalized else 'identity',kind=id_kind(key)))
    return result


def loss_marker(text):
    """Only explicit loss counts; ordinary 'dropped connection' is not log loss."""
    if not any(word in text.lower() for word in ('dropped','lost','chatty','suppressed')):
        return None
    m=LOSS_TIMED.search(text)
    if m and int(m[1])>0 and LOSS_CONTEXT.search(text):
        return dict(count=int(m[1]),start=m[2].replace(' ','T'),end=m[3].replace(' ','T'),source='hilog_quota')
    m=LOSS_COUNT.search(text)
    if m and int(m[1])>0 and LOSS_CONTEXT.search(text):
        return dict(count=int(m[1]),start=None,end=None,source='explicit_loss')
    m=re.search(r'\bchatty\b[^\n]*?\bexpire\s+(\d+)\s+lines?\b',text,re.I)
    if not m and re.search(r'\b(?:systemd-journald|journald|syslogd|rsyslogd|logd)\b',text,re.I):
        m=re.search(r'\b(?:suppressed|lost|dropped)\s*[:=]?\s*(\d+)\s+(?:messages|lines)\b',text,re.I)
    if m and int(m[1])>0:
        return dict(count=int(m[1]),start=None,end=None,source='explicit_loss')
    return None


def anomaly_priority(text,level):
    # Explicit successful states do not create failure candidates on their own.
    if level in ('F','FATAL','E','ERROR'):
        return 3
    parsed=HILOG.match(text) or HILOG_COMPACT.match(text) or ISO.match(text)
    message=parsed.groups()[-1] if parsed else text
    loss=loss_marker(text)
    # Generic identifier tokenization, independent of any app's method names.
    words=CAMEL.sub(r'\1 \2',message).replace('_',' ')
    def code_value(match):
        key=match[1].replace(' ','').lower();value=int(match[2])
        http=key=='statuscode' or bool(re.search(r'\bHTTP\b',words,re.I))
        return '' if value==0 or http and 200<=value<300 else ' failureCodeValue '
    reduced=CODE.sub(code_value,words)
    reduced=EMPTY_STATE.sub('',reduced);reduced=COUNTER_ZERO.sub('',reduced);reduced=TIMEOUT_SETTING.sub('',reduced)
    # A UI input event name is not a cancelled business request.
    reduced=re.sub(r'\b(?:touch\s*\w*|pointer\s*\w*|key\s*\w*)\s+(?:or\s+)?cancel\s+event\b','',reduced,flags=re.I)
    if loss:
        reduced=LOSS_TIMED.sub('',reduced);reduced=LOSS_COUNT.sub('',reduced);reduced=LOSS_NAMED.sub('',reduced)
    failure='failureCodeValue' in reduced or bool(FAILURE_WORDS.search(reduced))
    suspicious=suspected_loss(message)
    return 2 if failure else 0 if loss else 1 if suspicious or level in ('W','WARN','WARNING') else 0


def suspected_loss(text):
    m=re.search(r'\b(?:([1-9]\d*)\s+(?:dropped|discarded)|(?:dropped|discarded)\s+([1-9]\d*))\b',text,re.I)
    return bool(m and re.search(r'\b(?:messages|lines|logs)\b',text,re.I) and not loss_marker(text))


def parse(text):
    m = HILOG.match(text) or HILOG_COMPACT.match(text)
    if m:
        t, pid, tid, level, tag, message = m.groups()
        fmt = 'hilog'
    else:
        m = ISO.match(text)
        t, message = m.groups() if m else (None, text)
        pid, tid, tag = '', '', ''
        level_match=re.match(r'^\[?(FATAL|ERROR|WARNING|WARN|INFO|DEBUG|TRACE)\]?(?:\s|:)',message)
        level=(level_match[1].replace('WARNING','WARN') if level_match else '')
        fmt = 'text_ts' if m else 'plain'
    norm = None;clock=None
    if t:
        try:
            normalized=t.replace(',', '.').replace('Z', '+00:00')
            normalized=re.sub(r'\s+([+-]\d\d(?::?\d\d)?)$',r'\1',normalized)
            normalized=re.sub(r'([+-]\d\d)(\d\d)$',r'\1:\2',normalized)
            normalized=re.sub(r'([+-]\d\d)$',r'\1:00',normalized)
            normalized=re.sub(r'\.(\d+)',lambda m:'.'+m[1][:6].ljust(6,'0'),normalized,count=1)
            obj=dt.datetime.fromisoformat(('2000-' if fmt == 'hilog' else '') + normalized);norm=obj.isoformat();clock=encode_datetime(obj)
        except ValueError:
            pass
    ids = extract_ids(message)
    trace = TRACE.search(text)
    if trace:
        ids.extend(dict(key=k, raw=v, norm=v.lower().lstrip('0') or '0', rule='hex',kind='instance') for k, v in zip(('chainId', 'spanId', 'parentSpanId'), trace.groups()))
    # Preserve return-code distinctions before normalizing variable payloads.
    codes=[]
    def protect_code(match):
        marker='\ue000'+chr(0x100+len(codes))+'\ue001';codes.append((marker,match[2]));return match[1]+marker
    template=T_CODE.sub(protect_code,message)
    template=T_PATH.sub('<path>',template);template=T_UUID_IP.sub('<id>',template)
    template=IDS.sub(lambda m:m[1]+'=<id>' if id_key(m[1]) else m[0],template)
    if '**' in template:
        template=T_MASKED.sub('<masked>',template)
    template=T_PAYLOAD.sub('<payload>',template)
    template=T_HEX.sub('<v>',template);template=T_DIGITS.sub('<v>',template)
    template=T_QUOTES.sub(lambda m:m[0] if T_LABEL.fullmatch(m[2]) else '<text>',template)
    for marker,value in codes:
        template=template.replace(marker,value)
    template=template[:240]
    return dict(time=t,norm=norm,clock=clock,format=fmt,pid=pid,tid=tid,tag=tag,level=level,ids=ids,template=template,messageStart=len(text)-len(message))
