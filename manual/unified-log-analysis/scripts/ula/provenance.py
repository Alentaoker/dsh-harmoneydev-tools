"""Bind executions to a deterministic source-tree identity, excluding private data."""
import hashlib
import json
from pathlib import Path

ALGORITHM='sha256-path-content-lf-v2'
TEXT_SUFFIXES={'.py','.md','.json','.html','.css','.js','.mjs','.cjs','.txt','.yaml','.yml','.toml','.csv'}


def metadata_name(name):
    return name.casefold() in ('.ds_store','thumbs.db','desktop.ini','icon\r') or name.startswith('._')


def file_manifest(root):
    entries=[]
    for path in sorted(Path(root).rglob('*')):
        rel=path.relative_to(root)
        if not path.is_file() or any(p in ('__pycache__','.git','private','reports') for p in rel.parts) or path.suffix=='.pyc' or path.name=='build-manifest.json' or metadata_name(path.name): continue
        data=path.read_bytes()
        if path.suffix.casefold() in TEXT_SUFFIXES:
            try:
                data.decode('utf-8')
                data=data.replace(b'\r\n',b'\n')
            except UnicodeDecodeError: pass
        entries.append((rel.as_posix(),hashlib.sha256(data).hexdigest()))
    return dict(entries)


def source_identity(root):
    entries=file_manifest(root)
    payload=''.join(name+'\0'+digest+'\n' for name,digest in entries.items()).encode('utf-8')
    return dict(algorithm=ALGORITHM,sourceHash=hashlib.sha256(payload).hexdigest(),fileCount=len(entries))


def execution_identity(root):
    identity=source_identity(root);manifest=Path(root)/'build-manifest.json'
    if manifest.exists():
        binding=json.loads(manifest.read_text(encoding='utf-8'))
        actual=file_manifest(root);expected=binding.get('files',{})
        changed=sorted(name for name in actual.keys()|expected.keys() if actual.get(name)!=expected.get(name))
        verified=binding.get('algorithm')==ALGORITHM and binding.get('packageHash')==identity['sourceHash'] and bool(expected) and not changed
        identity.update(packageHash=identity['sourceHash'],sourceHash=binding['sourceHash'],host=binding['host'],identityStatus='verified' if verified else 'unverified',expectedPackageHash=binding.get('packageHash'),identityDifferences=changed,identityNote='' if verified else '身份未核验：宿主包与清单不同或清单版本过旧；报告保留实际包身份，请确认来源')
    return identity
