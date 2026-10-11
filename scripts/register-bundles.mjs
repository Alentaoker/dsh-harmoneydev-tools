import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export function includeBundles(pkg) {
  if (!pkg.dsh?.profile || !Array.isArray(pkg.dsh.profile.bundles)) throw new Error('目标文件不是已初始化的 DSH profile 包清单');
  for (const name of ['dsh-harmony', 'dsh-e2e']) {
    if (!pkg.dependencies?.[name]) throw new Error(`请先通过 DSH plugin add 安装 ${name}`);
    if (!pkg.dsh.profile.bundles.includes(name)) pkg.dsh.profile.bundles.push(name);
  }
  return pkg;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const file = resolve(process.argv[2] || '');
  if (!process.argv[2]) throw new Error('请传目标 profile 的 package.json');
  const pkg = includeBundles(JSON.parse(await readFile(file, 'utf8')));
  const temporary = `${file}.dsh-harmony-e2e-${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(pkg, null, 2) + '\n', { flag: 'wx' });
  await rename(temporary, file);
  console.log('dshHarmony 与 dshE2E bundle 已注册；其他配置保留。');
}
