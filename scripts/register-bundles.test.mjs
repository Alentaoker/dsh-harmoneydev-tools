import test from 'node:test';
import assert from 'node:assert/strict';
import { includeBundles } from './register-bundles.mjs';
test('注册顺序正确、保留其他插件和配置、重复执行不重复追加', () => {
  const pkg={dependencies:{'dsh-harmony':'file:harmony','dsh-e2e':'file:e2e',existing:'1'},dsh:{profile:{bundles:['existing'],settings:{keep:true}}},other:{keep:'yes'}};
  includeBundles(pkg);includeBundles(pkg);
  assert.deepEqual(pkg.dsh.profile.bundles,['existing','dsh-harmony','dsh-e2e']);assert.deepEqual(pkg.other,{keep:'yes'});assert.equal(pkg.dsh.profile.settings.keep,true);assert.equal(pkg.dependencies.existing,'1');
});
test('缺少安装或非法清单明确拒绝', () => {
  assert.throws(()=>includeBundles({dsh:{profile:{bundles:[]}},dependencies:{}}),/先通过/);
  assert.throws(()=>includeBundles({}),/已初始化/);
});
