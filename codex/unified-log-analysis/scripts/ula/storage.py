"""Disposable compact index. Public reports never depend on this schema."""
from collections import Counter,OrderedDict
import datetime as dt
import sqlite3
import hashlib
import re

NAIVE=32767
EPOCH=dt.datetime(1970,1,1)
EPOCH_UTC=EPOCH.replace(tzinfo=dt.timezone.utc)


def parse_datetime(value):
    normalized=value.replace(',', '.').replace('Z','+00:00')
    normalized=re.sub(r'\s+([+-]\d\d(?::?\d\d)?)$',r'\1',normalized)
    normalized=re.sub(r'([+-]\d\d)(\d\d)$',r'\1:\2',normalized)
    normalized=re.sub(r'(?<=\d)([+-]\d\d)$',r'\1:00',normalized) if re.search(r'\d\d:\d\d:\d\d',normalized) else normalized
    normalized=re.sub(r'\.(\d+)',lambda m:'.'+m[1][:6].ljust(6,'0'),normalized,count=1)
    return dt.datetime.fromisoformat(normalized)


def encode_time(value):
    if not value:
        return None,0,NAIVE
    return encode_datetime(parse_datetime(value))


def encode_datetime(obj):
    delta=obj-EPOCH_UTC if obj.tzinfo else obj-EPOCH
    zone=int(obj.utcoffset().total_seconds()/60) if obj.tzinfo else NAIVE
    return delta.days*86400000+delta.seconds*1000+delta.microseconds//1000,delta.microseconds%1000,zone


def micros(value):
    millis,sub,_=encode_time(value)
    return millis*1000+sub


def time_predicate(start,end):
    a,b=micros(start),micros(end)
    return '(timeMs BETWEEN ? AND ? AND timeUs BETWEEN ? AND ?)',[a//1000,b//1000,a,b]


def decode_time(milliseconds,remainder=0,zone=NAIVE):
    if milliseconds is None:
        return None
    obj=EPOCH_UTC+dt.timedelta(milliseconds=milliseconds,microseconds=remainder or 0)
    return (obj.replace(tzinfo=None) if zone==NAIVE else obj.astimezone(dt.timezone(dt.timedelta(minutes=zone)))).isoformat()


def configure(db):
    db.create_function('ula_time',3,decode_time,deterministic=True)


def create(db):
    db.executescript('''
      PRAGMA user_version=3;
      PRAGMA journal_mode=MEMORY;
      PRAGMA synchronous=OFF;
      CREATE TABLE files(id INTEGER PRIMARY KEY,name TEXT UNIQUE);
      CREATE TABLE headers(id INTEGER PRIMARY KEY,level TEXT,tag TEXT,pid TEXT,tid TEXT,zone INTEGER,UNIQUE(level,tag,pid,tid,zone));
      CREATE TABLE templates(id INTEGER PRIMARY KEY,fingerprint BLOB UNIQUE,template TEXT,count INTEGER,firstfile TEXT,firstline INTEGER);
      CREATE TABLE identifiers(id INTEGER PRIMARY KEY,value TEXT,key TEXT,UNIQUE(value,key));
      CREATE TABLE records(fileId INTEGER,n INTEGER,off INTEGER,len INTEGER,t INTEGER,sub INTEGER,headerId INTEGER,templateId INTEGER,PRIMARY KEY(fileId,n)) WITHOUT ROWID;
      CREATE TABLE occurrences(fileId INTEGER,n INTEGER,identifierId INTEGER,PRIMARY KEY(fileId,n,identifierId)) WITHOUT ROWID;
      CREATE VIEW lines AS SELECT files.name file,n,off,len,t timeMs,sub subMillis,(t*1000+sub) timeUs,ula_time(t,sub,headers.zone) time,headers.zone tzMinutes,level,tag,pid,tid,templates.template FROM records JOIN files ON records.fileId=files.id JOIN headers ON records.headerId=headers.id JOIN templates ON records.templateId=templates.id;
      CREATE VIEW ids AS SELECT identifiers.key,identifiers.value,files.name file,occurrences.n FROM occurrences JOIN identifiers ON occurrences.identifierId=identifiers.id JOIN files ON occurrences.fileId=files.id;
      CREATE TRIGGER insert_ids INSTEAD OF INSERT ON ids BEGIN
        INSERT OR IGNORE INTO identifiers(value,key) VALUES(NEW.value,NEW.key);
        INSERT OR IGNORE INTO occurrences(fileId,n,identifierId) SELECT files.id,NEW.n,identifiers.id FROM files,identifiers WHERE files.name=NEW.file AND identifiers.value=NEW.value AND identifiers.key=NEW.key;
      END;
    ''')


class Builder:
    def __init__(self,db):
        self.db=db;self.caches={name:OrderedDict() for name in ('headers','templates','identifiers')}
        self.rows=[];self.ids=[];self.counts=Counter();self.returning=sqlite3.sqlite_version_info>=(3,35,0)

    def intern(self,table,values):
        cache=self.caches[table]
        if values in cache:
            ident=cache.pop(values);cache[values]=ident;return ident
        if table=='templates':
            fingerprint=hashlib.sha256(values[0].encode()).digest()
            columns='fingerprint,template,count,firstfile,firstline';params=(fingerprint,values[0],0,'',0);conflict='fingerprint';update='count=templates.count';lookup='fingerprint=?'
        elif table=='headers':
            columns='level,tag,pid,tid,zone';params=values;conflict=columns;update='level=excluded.level';lookup=' AND '.join(k+'=?' for k in columns.split(','))
        else:
            columns='value,key';params=values;conflict=columns;update='value=excluded.value';lookup='value=? AND key=?'
        sql=f'INSERT INTO {table}({columns}) VALUES({",".join("?" for _ in params)}) ON CONFLICT({conflict}) DO UPDATE SET {update}'
        if self.returning:
            row=self.db.execute(sql+(' RETURNING id,template' if table=='templates' else ' RETURNING id'),params).fetchone();ident=row[0]
            if table=='templates' and row[1]!=values[0]:
                raise ValueError('模板指纹冲突，停止建立索引')
        else:
            self.db.execute(sql,params);row=self.db.execute(f'SELECT id'+(',template' if table=='templates' else '')+f' FROM {table} WHERE '+lookup,(fingerprint,) if table=='templates' else values).fetchone();ident=row[0]
            if table=='templates' and row[1]!=values[0]:
                raise ValueError('模板指纹冲突，停止建立索引')
        cache[values]=ident
        if len(cache)>8192:
            cache.popitem(last=False)
        return ident

    def feed(self,file_id,n,off,size,parsed):
        t,sub,zone=parsed.get('clock') or encode_time(parsed['norm'])
        header=self.intern('headers',(parsed['level'],parsed['tag'],parsed['pid'],parsed['tid'],zone))
        template=self.intern('templates',(parsed['template'],));self.counts[template]+=1
        self.rows.append((file_id,n,off,size,t,sub,header,template))
        self.ids.extend((file_id,n,self.intern('identifiers',(item['norm'],item['key'].lower()))) for item in parsed['ids'])
        if len(self.rows)>=8192:
            self.flush()

    def flush(self):
        self.db.executemany('INSERT INTO records VALUES(?,?,?,?,?,?,?,?)',self.rows)
        self.db.executemany('INSERT OR IGNORE INTO occurrences VALUES(?,?,?)',self.ids)
        self.db.executemany('UPDATE templates SET count=count+? WHERE id=?',[(count,key) for key,count in self.counts.items()])
        self.db.commit();self.rows.clear();self.ids.clear();self.counts.clear()

    def finish(self):
        self.flush()
        self.db.executescript('CREATE INDEX idx_time ON records(t,fileId,n) WHERE t IS NOT NULL; CREATE INDEX idx_template ON records(templateId,fileId,n); CREATE INDEX idx_identifier ON occurrences(identifierId,fileId,n);')
