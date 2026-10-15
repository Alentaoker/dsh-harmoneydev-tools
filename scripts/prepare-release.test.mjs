import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,copyFile,readdir,rm} from 'node:fs/promises';
import {join,dirname,basename,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

test('release staging keeps session source modules and their hashes while excluding user data and credentials',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dsh-release-fixture-')),source=join(root,'source'),stage=join(root,'stage');
  try{
    for(const name of ['plugin/dsh-harmony/vendor/lib','plugin/dsh-e2e','scripts','docs','skill'])await mkdir(join(source,name),{recursive:true});
    for(const name of ['prepare-release.mjs','release-files.mjs'])await copyFile(new URL(name,import.meta.url),join(source,'scripts',name));
    for(const name of ['README.md','CHANGELOG.md','THIRD_PARTY_NOTICES.md','LICENSE'])await writeFile(join(source,name),'fixture');
    for(const name of ['dsh-harmony','dsh-e2e'])await writeFile(join(source,'plugin',name,'package.json'),JSON.stringify({name,version:'1.0.0'}));
    const lib=join(source,'plugin/dsh-harmony/vendor/lib');
    const included=['session-reader.ts','session-control-store.ts','session.ts','SessionSidebar.tsx','session-log.test.mjs'];
    const excluded=['session.v4.jsonl','session.v4.jsonl.gz','session-123.json','session.txt','.env','.ENV.local','.npmrc','.git-credentials','trace.log','private.key'];
    for(const name of [...included,...excluded])await writeFile(join(lib,name),'fixture '+name);
    const run=()=>spawnSync(process.execPath,[join(source,'scripts/prepare-release.mjs'),stage],{encoding:'utf8',windowsHide:true});
    const result=run();assert.equal(result.status,0,result.stderr);
    const entries=await readdir(join(stage,'plugin/dsh-harmony/vendor/lib'));
    assert.deepEqual(entries.sort(),included.sort());
    const manifest=JSON.parse(await readFile(join(stage,'release-manifest.json'),'utf8'));
    assert.ok(manifest.files.some(f=>f.path.endsWith('/session-reader.ts')));
    for(const file of manifest.files)assert.equal(file.sha256,createHash('sha256').update(await readFile(join(stage,file.path))).digest('hex'));
    assert.notEqual(run().status,0,'an existing release stage must not be overwritten');
  }finally{
    if(dirname(root)!==resolve(tmpdir())||!basename(root).startsWith('dsh-release-fixture-'))throw Error('Refusing unexpected cleanup path');
    await rm(root,{recursive:true,force:true});
  }
});
