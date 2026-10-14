import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, readdir, symlink, stat } from 'node:fs/promises';
import { resolve, join, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { createLogLibrary } from './log-library.mjs';
import { archivedLogPage, DEFAULT_LOG_BYTES } from './log-archive.mjs';
import { resolveLogTarget, startLogCollection, logPage, logDigest } from './logs.mjs';
import { createRecordStore, assertScope, paginate, activeStatuses } from './records.mjs';
import { reportView, failureCategory } from './presentation.mjs';
import { maskedEvidence } from './evidence.mjs';
import { validateToolCall } from './tool-contract.mjs';
import { requireVisualModel, visualVerification } from './verification.mjs';

export const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const dataRoot = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'storages', 'dshE2E');
const allowedActions = ['tap', 'fill', 'clear', 'focus', 'swipe', 'press', 'assert', 'home', 'back'];
const selectors = ['text', 'testId', 'role'];
export function validateRun(input) {
  if (!input || typeof input !== 'object') throw new Error('任务参数必须是对象');
  validateToolCall({ ...input, operation: 'run' });
  const goal = String(input.goal || '').trim();
  if (!goal || goal.length > 4000) throw new Error('请提供最多 4000 字的具体任务目标');
  if (input.appBundle && !/^[A-Za-z][A-Za-z0-9_.]{1,254}$/.test(input.appBundle)) throw new Error('应用包名无效');
  if (input.appAbility && !/^[A-Za-z][A-Za-z0-9_.$]{0,254}$/.test(input.appAbility)) throw new Error('应用入口名称无效');
  if (input.logAppBundle && !/^[A-Za-z][A-Za-z0-9_.]{1,254}$/.test(input.logAppBundle)) throw new Error('日志目标包名无效');
  if (input.appName !== undefined && (typeof input.appName !== 'string' || !input.appName.trim() || input.appName.length > 256)) throw new Error('应用名称无效');
  if (input.collectLogs !== undefined && typeof input.collectLogs !== 'boolean') throw new Error('collectLogs 必须为布尔值');
  const steps = input.steps;
  const runMode = input.runMode ?? 'workflow', verificationMode = input.verificationMode ?? 'semantic';
  if (!['workflow', 'verify_current'].includes(runMode)) throw Error('runMode 必须为 workflow 或 verify_current');
  if (!['semantic', 'visual'].includes(verificationMode)) throw Error('verificationMode 必须为 semantic 或 visual');
  if (runMode === 'verify_current' && (input.appBundle || steps?.some(step => step.action !== 'assert'))) throw Error('verify_current 只验当前页，不能重启应用或包含操作步骤');
  if (verificationMode === 'visual' && (typeof input.expectation !== 'string' || !input.expectation.trim())) throw Error('视觉验收需要明确的 expectation');
  if (steps !== undefined) {
    if (!Array.isArray(steps) || !steps.length || steps.length > 40) throw new Error('确定性流程需要 1～40 步');
    for (const step of steps) {
      if (!allowedActions.includes(step.action)) throw new Error(`不支持的流程动作：${step.action}`);
      if (!['home', 'back', 'swipe'].includes(step.action) && (!step.selector || !selectors.includes(step.selector.kind) || typeof step.selector.value !== 'string' || !step.selector.value || step.selector.value.length > 512)) throw new Error('此步骤需要明确的控件选择器');
      if (step.action === 'fill' && (typeof step.text !== 'string' || step.text.length > 8192)) throw new Error('输入文字无效');
      if (step.action === 'swipe' && !['up', 'down', 'left', 'right'].includes(step.direction)) throw new Error('滑动方向无效');
      if (step.action === 'press' && !['Enter', 'Escape'].includes(step.key)) throw new Error('只支持 Enter 或 Escape');
    }
    if (!steps.some(s => s.action === 'assert')) throw new Error('确定性流程必须包含至少一项结果断言');
  } else if (typeof input.expectation !== 'string' || !input.expectation.trim() || input.expectation.length > 2000) throw new Error('自然语言任务必须提供可从屏幕确认的验收条件 expectation');
  return { goal, runMode, verificationMode, expectation: input.expectation, appBundle: input.appBundle, appAbility: input.appAbility, logAppBundle: input.logAppBundle, appName: input.appName?.trim(), collectLogs: input.collectLogs !== false, logMaxBytes: Math.min(128 * 1024 * 1024, Math.max(1024 * 1024, Number(input.logMaxBytes) || DEFAULT_LOG_BYTES)), serial: input.serial, steps,
    timeoutMs: Math.min(300000, Math.max(20000, Number(input.timeoutMs) || 300000)), maxActions: Math.min(30, Math.max(1, Math.floor(Number(input.maxActions) || 30))), maxModelCalls: Math.min(20, Math.max(1, Math.floor(Number(input.maxModelCalls) || 20))), name: String(input.name || goal).slice(0, 120) };
}
export function inside(root, requested) { const destination = resolve(root, requested); const rel = relative(root, destination); if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('文件路径超出报告目录'); return destination; }
export function createService(ctx, root = dataRoot) {
  const jobs = new Map(), secrets = new Map(); let server, baseURL, starting = false;
  const store = createRecordStore(root), logLibrary = createLogLibrary(root);
  const manager = () => { const m = ctx.dshHarmony.automation?.getManager?.(); if (!m) throw new Error('需要支持自动化桥接的 dshHarmony，请重启 DSH 加载更新'); return m; };
  const summary = job => ({ id: job.id, runMode: job.args?.runMode || 'workflow', verificationMode: job.args?.verificationMode || 'semantic', verificationEvidence: job.verificationEvidence, errorCode: job.errorCode, flowId: job.flowId, name: job.args?.name || job.name, status: job.status, createdAt: job.createdAt, completedAt: job.completedAt, durationMs: job.durationMs, reportUrl: `/api/dsh-e2e/report?id=${job.id}&sessionId=${encodeURIComponent(job.sessionId || '')}`, checks: job.checks, error: job.error, failure: failureCategory(job), device: typeof job.device === 'string' ? job.device : job.device?.name || job.device?.model, cache: job.cache, sessionId: job.sessionId, progress: job.progress, logCollection: job.logCollection, logCount: job.logCollection?.persisted ?? job.logCount ?? job.logs?.length ?? 0, parentRunId: job.parentRunId, relation: job.relation, archived: job.archived || false });
  async function persist(job) { const record = summary(job); await store.save(record, { ...record, args: job.args, logs: job.logs, evidence: job.evidence, evidenceWarnings: job.evidenceWarnings, modelIdentity: job.modelIdentity, engine: 'e2e@0.19.0' }); }
  async function evidence(job, label, name) {
    if (job.controller.signal.aborted) return;
    try {
      const m=manager(),signal=AbortSignal.any([job.controller.signal,AbortSignal.timeout(6000)]), common={serial:job.device.serial,leaseToken:job.lease.token,signal};
      const raw=await m.snapshot({...common,includeTree:true,includeScreenshot:true});
      const geometry=await m.getDisplayGeometry(job.device.serial,signal), image=await maskedEvidence(raw,geometry);
      await writeFile(join(job.directory,name),image); (job.evidence ||= []).push({label,file:name});
    } catch { (job.evidenceWarnings ||= []).push(`${label}未保存：截图、完整控件树或匹配的坐标不可用。`); }
  }
  async function handle(job, operation, input) {
    const m = manager(), signal = AbortSignal.any([job.controller.signal, AbortSignal.timeout(operation === 'model' ? 90000 : 30000)]);
    signal.throwIfAborted(); if (job.lease) m.renewLease(job.lease.token, 60000);
    const common = { serial: job.device.serial, leaseToken: job.lease.token, signal };
    if (operation === 'device') return { name: job.device.name, model: job.device.model, osVersion: job.device.osVersion, apiVersion: job.device.apiVersion };
    if (operation === 'logs') { const entries = job.pendingLogs.splice(0); job.pendingLogBytes = 0; return { entries }; }
    if (operation === 'observe') {
      job.progress = { ...job.progress, stage: 'observing' };
      const raw = await m.snapshot({ ...common, includeTree: true, includeScreenshot: !!input.pixels });
      void job.logCollector?.refresh();
      const geometry = m.getDisplayGeometry ? await m.getDisplayGeometry(job.device.serial,signal) : await m.getFrameGeometry(job.device.serial, 'screenshot', signal);
      job.viewport = { width: geometry.nativeWidth, height: geometry.nativeHeight };
      return { nodes: raw.nodes, quality: raw.quality, targetApp: job.args.appBundle, generation: raw.generation, revision: raw.revision, viewport: job.viewport, ...(input.pixels && raw.screenshot ? { pixels: { data: raw.screenshot.data.toString('base64') } } : {}) };
    }
    if (operation === 'open') { if (!job.args.appBundle) throw new Error('重新启动需要明确的应用包名'); await m.stopApp({ ...common, bundleName: job.args.appBundle }); await m.launchApp({ ...common, bundleName: job.args.appBundle, abilityName: job.args.appAbility }); await job.logCollector?.refresh(); return { ok: true }; }
    if (operation === 'key') { if (!['home', 'back', 'enter'].includes(input.key)) throw new Error('不支持的按键'); await m.pressKey({ ...common, key: input.key }); return { ok: true }; }
    if (operation === 'wait') { if (!Number.isInteger(input.waitMs) || input.waitMs < 100 || input.waitMs > 10000) throw Error('waitMs 必须在100到10000之间'); await new Promise((resolve, reject) => { const abort = () => { clearTimeout(timer); reject(signal.reason); }; const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, input.waitMs); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); }); return { waitedMs: input.waitMs }; }
    if (operation === 'input') { if (typeof input.text !== 'string' || input.text.length > 8192) throw new Error('文字无效'); await m.inputText({ ...common, text: input.text }); return { ok: true }; }
    if (operation === 'perform') {
      const { node, action } = input; if (!allowedActions.includes(action?.kind)) throw new Error('不支持的动作');
      job.progress = { ...job.progress, stage: 'acting', action: action.kind };
      if (node && (node.enabled === false || node.visible === false)) throw new Error('目标控件不可操作');
      if (['tap', 'focus', 'fill', 'clear'].includes(action.kind)) {
        if (!node?.ref || !Number.isSafeInteger(node.generation)) throw new Error('缺少当前控件引用');
        await m.tapRef({ ...common, ref: node.ref, generation: node.generation });
        if (action.kind === 'fill' || action.kind === 'clear') { const text = action.kind === 'clear' ? '' : action.value; if (typeof text !== 'string' || text.length > 8192) throw new Error('文字无效'); if (text) await m.inputText({ ...common, text }); else { if (!node.id) throw new Error('清空输入需要唯一的控件资源 ID'); const result = await m.runScenario({ ...common, steps: [{ action: 'clear_text', selector: { id: node.id, type: node.type } }], settleAfterAction: false }); if (result.status !== 'passed') throw new Error('清空输入未通过'); } }
      } else if (action.kind === 'press') { if (!['Enter', 'Escape'].includes(action.key)) throw new Error('按键不支持'); await m.pressKey({ ...common, key: action.key === 'Enter' ? 'enter' : 'back' }); }
      else if (action.kind === 'swipe') {
        if (!['up', 'down', 'left', 'right'].includes(action.direction)) throw new Error('滑动方向无效');
        const g = m.getDisplayGeometry ? await m.getDisplayGeometry(job.device.serial,signal) : await m.getFrameGeometry(job.device.serial, 'screenshot', signal); const b = node?.bounds || { left: 0, top: 0, right: g.nativeWidth, bottom: g.nativeHeight };
        const cx = (b.left + b.right) / 2, cy = (b.top + b.bottom) / 2, dx = (b.right - b.left) * .25, dy = (b.bottom - b.top) * .25;
        const vertical = ['up', 'down'].includes(action.direction), sign = ['up', 'left'].includes(action.direction) ? 1 : -1;
        await m.swipe({ ...common, coordinateSpace: 'native', fromX: Math.round(cx + (vertical ? 0 : dx * sign)), fromY: Math.round(cy + (vertical ? dy * sign : 0)), toX: Math.round(cx - (vertical ? 0 : dx * sign)), toY: Math.round(cy - (vertical ? dy * sign : 0)), durationMs: 350 });
      }
      return { ok: true };
    }
    if (operation === 'pointer') {
      const { point, action } = input; if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) throw new Error('坐标无效');
      if (action.kind === 'tap') await m.tap({ ...common, coordinateSpace: 'native', x: Math.round(point.x), y: Math.round(point.y), generation: input.generation });
      else if (action.kind === 'swipeTo' && Number.isFinite(action.target?.x) && Number.isFinite(action.target?.y)) await m.swipe({ ...common, coordinateSpace: 'native', fromX: Math.round(point.x), fromY: Math.round(point.y), toX: Math.round(action.target.x), toY: Math.round(action.target.y), durationMs: 350 });
      else throw new Error('坐标动作不支持'); return { ok: true };
    }
    if (operation === 'model') {
      const { provider, model } = job.model || {}; if (!provider || !model) throw new Error('当前会话没有配置模型，请选择模型后重试');
      if (typeof input.system !== 'string' || typeof input.input !== 'string' || input.input.length > 200000) throw new Error('模型请求无效');
      let text = '', usage = {};
      job.progress = { ...job.progress, stage: input.system.includes('验收员') ? 'verifying' : 'thinking', modelCalls: (job.progress?.modelCalls || 0) + 1 };
      const content = job.args.verificationMode === 'visual' && input.assertOnly === true
        ? await visualVerification(ctx, m, job, input.input, signal) : [{ type: 'text', text: input.input }];
      const messages = [{ id: randomUUID(), role: 'user', source: { kind: 'user' }, content }];
      for await (const chunk of ctx.llm.stream({ provider, model, system: input.system, messages, maxTokens: 2048, signal })) {
        if (chunk.type === 'text-delta') text += chunk.text;
        if (chunk.type === 'usage') usage = { inputTokens: chunk.usage?.inputTokens, outputTokens: chunk.usage?.outputTokens };
        if (chunk.type === 'finish' && ['error', 'aborted'].includes(chunk.reason?.kind)) throw new Error(chunk.reason.failure?.message || '模型请求失败或取消');
      }
      return { text, usage, provider, model };
    }
    throw new Error('未知内部操作');
  }
  async function ready() {
    if (server) return;
    server = createServer(async (req, res) => {
      const token = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1]; const job = token && secrets.get(token);
      if (req.method !== 'POST' || req.url !== '/bridge' || !job || job.controller.signal.aborted) { res.writeHead(403); res.end('{}'); return; }
      let size = 0; const chunks = [];
      try { for await (const chunk of req) { size += chunk.length; if (size > 250000) throw new Error('请求过大'); chunks.push(chunk); } const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); const result = await handle(job, body.operation, body.input || {}); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result)); }
      catch (error) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: error.code || 'INVALID_ARGUMENT', message: error.message } })); }
    });
    await new Promise((resolveReady, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveReady); }); baseURL = `http://127.0.0.1:${server.address().port}/bridge`;
  }
  async function execute(job) {
    const m = manager(); let timer, renewal; const started = Date.now();
    try {
      await ready();
      job.controller.signal.throwIfAborted();
      const devices = (await m.listDevices(job.controller.signal)).filter(d => d.state === 'online' && d.capabilities.uiTree && d.capabilities.tap);
      job.device = job.args.serial ? devices.find(d => d.serial === job.args.serial) : devices.length === 1 ? devices[0] : undefined;
      if (!job.device) throw new Error('请选择唯一在线的鸿蒙设备');
      if (job.args.verificationMode === 'visual') await requireVisualModel(ctx, job.model, job.controller.signal);
      job.logCollection = { status: job.args.collectLogs ? 'unresolved' : 'disabled', warnings: [] };
      try { job.logTarget = await resolveLogTarget(m, job.device.serial, job.args, job.controller.signal); }
      catch (error) { job.logCollection.warnings.push(error.message); throw error; }
      const acquire = ctx.dshHarmony.automation.acquireForTask?.bind(ctx.dshHarmony.automation) || m.acquireLease.bind(m);
      job.lease = await acquire({ serial: job.device.serial, owner: { kind: 'agent', id: `dshE2E:${job.id}`, sessionId: job.sessionId }, ttlMs: 60000, signal: job.controller.signal });
      renewal = setInterval(() => { try { m.renewLease(job.lease.token, 60000); } catch { job.controller.abort(new Error('设备控制权已失效')); } }, 20000);
      timer = setTimeout(() => job.controller.abort(new Error('任务超过时间限制')), job.args.timeoutMs + 20000);
      await m.prepareDevice({ serial: job.device.serial, leaseToken: job.lease.token, signal: job.controller.signal });
      job.status = 'running';
      if (job.logTarget) job.logCollector = await startLogCollection(m, job);
      await evidence(job, '开始前页面', 'before.png');
      const token = randomBytes(32).toString('hex'); secrets.set(token, job); job.token = token;
      const workspace = job.workspace;
      await mkdir(join(workspace, 'tests'), { recursive: true });
      try { await stat(join(workspace, 'node_modules')); } catch { await symlink(join(pluginRoot, 'node_modules'), join(workspace, 'node_modules'), 'junction'); }
      await writeFile(join(workspace, 'package.json'), '{"private":true,"type":"module"}');
      const engineURL = pathToFileURL(join(pluginRoot, 'lib/engine.mjs')).href, executorURL = pathToFileURL(join(pluginRoot, 'lib/executor.mjs')).href;
      const output = relative(workspace, job.directory).replaceAll('\\', '/') + '/e2e';
      await writeFile(join(workspace, 'e2e.config.ts'), `import { harmonyEngine } from ${JSON.stringify(engineURL)};\nimport { harnessExecutor } from ${JSON.stringify(executorURL)};\nexport default { targets:[{name:'harmony',engine:harmonyEngine(),app:{${job.args.appBundle ? `bundleId:${JSON.stringify(job.args.appBundle)}` : ''}}}], agents:{default:{executor:harnessExecutor(),maxSteps:${job.args.maxActions},maxModelCalls:${job.args.maxModelCalls}}}, workers:1, retries:0, timeout:${job.args.timeoutMs}, actionTimeout:15000, launchTimeout:20000, output:${JSON.stringify(output)}, cache:{mode:${JSON.stringify(job.args.verificationMode === 'visual' ? 'off' : 'read-write')},dir:'.e2e/cache'}, trace:'on', reporters:['markdown','junit'] };\n`);
      let body = job.args.steps ? `const steps=${JSON.stringify(job.args.steps)}; for(const s of steps){ if(s.action==='home'||s.action==='back'){await device[s.action]();continue;} if(s.action==='swipe'){await screen.swipe(s.direction);continue;} const l=s.selector.kind==='testId'?screen.getByTestId(s.selector.value):s.selector.kind==='role'?screen.getByRole(s.selector.value,s.selector.name ? {name:s.selector.name}:undefined):screen.getByText(s.selector.value,{exact:true}); if(s.action==='assert'){if(s.text!==undefined)await expect(l).toHaveText(s.text);else await expect(l).toBeVisible();}else if(s.action==='fill'){await l.fill(s.text);}else if(s.action==='press'){await l.press(s.key);}else await l[s.action](); }` : `${job.args.runMode === 'verify_current' ? '' : `await agent.act(${JSON.stringify(job.args.goal)}); `}await agent.assert(${JSON.stringify(job.args.expectation)});`;
      if (job.args.steps && job.args.verificationMode === 'visual') body += ` await agent.assert(${JSON.stringify(job.args.expectation)});`;
      await writeFile(join(workspace, 'tests/task.e2e.ts'), `import {test,expect} from 'e2e';\ntest(${JSON.stringify((job.args.runMode === 'verify_current' ? '[当前页面补验] ' : '[本次流程] ') + job.args.name)},async({app,agent,screen,device})=>{${job.args.appBundle ? 'await app.open();' : ''}${body}});\n`);
      const cli = join(pluginRoot, 'node_modules/e2e/dist/cli/bin.js');
      const node = process.env.DSH_E2E_NODE_PATH || (/(?:^|[\\/])node(?:\.exe)?$/i.test(process.execPath) ? process.execPath : join(dirname(process.execPath), 'resources/runtime/primary-runtime/dependencies/node/bin/node.exe'));
      const env = { ...process.env, DSH_E2E_BRIDGE_URL: baseURL, DSH_E2E_BRIDGE_TOKEN: token, E2E_TELEMETRY_DISABLED: '1', NO_COLOR: '1' }; delete env.ELECTRON_RUN_AS_NODE;
      job.controller.signal.throwIfAborted();
      job.child = spawn(node, [cli, 'run', '--config', 'e2e.config.ts'], { cwd: workspace, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let transcript = ''; const append = data => { transcript = (transcript + data.toString()).slice(-128000); };
      job.child.stdout.on('data', append); job.child.stderr.on('data', append);
      const stop = () => { if (job.child && !job.child.killed) { if (process.platform === 'win32' && job.child.pid) spawn('taskkill.exe', ['/PID', String(job.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); else job.child.kill('SIGTERM'); } };
      job.controller.signal.addEventListener('abort', stop, { once: true });
      const code = await new Promise((resolveExit, reject) => { job.child.once('error', reject); job.child.once('exit', resolveExit); }); job.controller.signal.removeEventListener('abort', stop);
      await writeFile(join(job.directory, 'runner.log'), transcript.replaceAll(token, '[internal-token]'));
      try { job.report = JSON.parse(await readFile(join(job.directory, 'e2e/report.json'), 'utf8')); } catch {}
      job.status = job.controller.signal.aborted ? 'cancelled' : code === 0 && job.report ? 'passed' : 'failed';
      if (job.status === 'passed' && job.args.verificationMode === 'visual' && !job.verificationEvidence?.length) { job.status = 'failed'; job.error = '未记录独立视觉验收输入，不能标记通过'; }
      job.checks = { runnerExitCode: code, reportWritten: !!job.report, leaseReleased: false, visualInputCaptured: !!job.verificationEvidence?.length, historicalActionsRecorded: false, runMode: job.args.runMode, verificationMode: job.args.verificationMode };
      const cacheEvents = []; const visit = value => { if (!value || typeof value !== 'object') return; if (value.cache?.mode) cacheEvents.push(value.cache); for (const [key, child] of Object.entries(value)) if (key !== 'cache') { if (Array.isArray(child)) child.forEach(visit); else if (child && typeof child === 'object') visit(child); } }; visit(job.report); job.cache = cacheEvents;
      if (job.status !== 'passed') job.error = job.controller.signal.reason?.message || job.report?.run?.results?.flatMap(r => r.attempts || []).find(a => a.error)?.error?.message || job.report?.run?.errors?.[0]?.message || `e2e 执行未通过，请查看报告（退出码 ${code}）`;
    } catch (error) { job.status = job.controller.signal.aborted ? 'cancelled' : 'failed'; job.error = error.message; job.errorCode = error.code; }
    finally {
      job.progress = { ...job.progress, stage: 'finishing' };
      if (job.lease) await evidence(job, job.status === 'passed' ? '验收后页面' : '结束时页面', 'after.png');
      clearTimeout(timer); clearInterval(renewal);
      for (const cleanup of [() => job.logCollector?.stop(), () => job.logArchive?.close()]) { try { await cleanup(); } catch (error) { job.status = 'failed'; job.error = `${job.error || ''} 日志收尾失败：${error.message}`; } }
      secrets.delete(job.token);
      if (job.lease) { try { const released = await m.releaseLease(job.lease.token); job.checks = { ...job.checks, leaseReleased: released === true }; } catch (error) { job.error = `${job.error || ''} 释放控制失败：${error.message}`; job.status = 'failed'; } }
      job.checks = { ...job.checks, logTargetResolved: !!job.logTarget, logStreamConfirmed: !!job.logCollection?.streamConfirmed, logsCaptured: job.logs.length > 0 };
      job.completedAt = new Date().toISOString(); job.durationMs = Date.now() - started;
      try { if (!job.logArchive) await writeFile(join(job.directory, 'app-logs.jsonl'), job.logs.map(e => JSON.stringify(e)).join('\n') + (job.logs.length ? '\n' : '')); await persist(job); }
      finally { jobs.delete(job.id); }
    }
    return summary(job);
  }
  async function run(input, sessionId, model, signal, provenance = {}) {
    const args = validateRun(input);
    if (starting || jobs.size) throw new Error('已有手机测试正在执行或收尾，请等待完成');
    starting = true;
    if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 256) { starting = false; throw new Error('需要活动会话'); }
    const flowId = createHash('sha256').update(JSON.stringify([sessionId, args.name, args.goal, args.expectation, args.steps, args.appBundle, args.appAbility, args.logAppBundle, args.appName, args.collectLogs, args.runMode, args.verificationMode])).digest('hex').slice(0, 24);
    const id = randomUUID(), workspace = join(root, 'workflows', flowId), directory = join(workspace, 'runs', id);
    try { await mkdir(directory, { recursive: true }); } catch (error) { starting = false; throw error; }
    const controller = new AbortController(), job = { id, flowId, workspace, directory, sessionId, args, model, modelIdentity: model, controller, status: 'queued', createdAt: new Date().toISOString(), logs: [], pendingLogs: [], progress: { stage: 'preparing', modelCalls: 0 }, ...provenance }; jobs.set(id, job);
    try { await persist(job); } catch (error) { jobs.delete(id); starting = false; throw error; } starting = false;
    const abort = () => controller.abort(signal.reason); if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    job.promise = execute(job).finally(() => signal?.removeEventListener('abort', abort)); const result = await job.promise; return { ...result, diagnostics: logDigest(job) };
  }
  async function list() { const all = new Map((await store.all()).map(v => [v.id, v])); for (const job of jobs.values()) all.set(job.id, summary(job)); return [...all.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))); }
  async function get(id, scope) { if (!/^[0-9a-f-]{36}$/.test(id || '')) throw new Error('报告 ID 无效'); if (jobs.has(id)) { const job = jobs.get(id); assertScope(job, scope); return job; } return store.get(id, scope); }
  return { run, list, get, summary, busy: () => starting || jobs.size > 0, logLibrary, listPage: async options => paginate(await list(), options), getLogs: async (id, options, scope) => { const job = await get(id, scope); return await archivedLogPage(job, options) ?? logPage(job, options); }, getDiagnostics: async (id, scope) => logDigest(await get(id, scope)),
    async report(id, scope) { const job = await get(id, scope); let report = job.report; if (!report) try { report = JSON.parse(await readFile(join(job.directory, 'e2e/report.json'), 'utf8')); } catch {} const related = (await list()).filter(r => r.id !== job.id && r.sessionId === job.sessionId && (r.id === job.parentRunId || r.parentRunId === job.id || job.parentRunId && r.parentRunId === job.parentRunId)); return { run: summary(job), view: reportView(job, report), related: related.slice(0, 50), diagnostics: logDigest(job) }; },
    async archive(id, archived, scope) { const job = await get(id, scope); if (job.controller) throw new Error('进行中或收尾中的任务不能归档'); job.archived = archived; await persist(job); return summary(job); },
    async resolveApp(query = '', serial, signal, offset = 0, limit = 100) {
      if (typeof query !== 'string' || query.length > 256 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('应用查询参数无效');
      const m = manager(), devices = (await m.listDevices(signal)).filter(d => d.state === 'online');
      const device = serial ? devices.find(d => d.serial === serial) : devices.length === 1 ? devices[0] : undefined;
      if (!device) throw new Error('请选择唯一在线手机');
      const apps = await m.applications(device.serial, query, undefined, signal);
      return { query, total: apps.length, offset, candidates: apps.slice(offset, offset + limit).map(({ bundleName, label, process }) => ({ bundleName, label, process })), nextOffset: offset + limit < apps.length ? offset + limit : null, resolved: apps.length === 1 ? apps[0].bundleName : null, instruction: '本次仅查询，未创建 E2E run。接下来请用 run+goal+expectation。应用内页面名称可能没有独立包名；核实宿主后传 logAppBundle，仅采日志不重启。只验当前页用 runMode:verify_current，不补发消息。' };
    },
    status: async scope => ({ plugin: 'dshE2E', version: '0.4.0-rc.1', routing: 'e2e-default', e2eRunCreated: false, e2eVersion: '0.19.0', storage: root, harmonyReady: !!ctx.dshHarmony.automation, devices: (await manager().listDevices()).map(({ serial, name, model, state }) => ({ serial, name, model, state })), busy: jobs.size > 0, active: [...jobs.values()].filter(j => !scope || scope.all || j.sessionId === scope.sessionId).map(j=>({...summary(j),status:j.status==='queued'?'queued':'running'})) }),
    async cancel(id, scope) { const job = await get(id, scope); if (!job.controller) throw new Error('此任务已结束'); job.controller.abort(new Error('用户取消')); await job.promise; return summary(job); },
    async replay(id, sessionId, model, signal) { const job = await get(id, { sessionId }); if (job.controller) throw new Error('请先等待原任务结束'); if (job.status !== 'passed') throw new Error('仅通过的流程可以复用；未通过的任务请调整复测'); return run(job.args, sessionId, model, signal, { parentRunId: id, relation: 'replay' }); },
    async retry(id, changes, sessionId, model, signal) { const job = await get(id, { sessionId }); if (job.controller) throw new Error('请先结束原任务'); const allowed = ['goal', 'expectation', 'name', 'appBundle', 'appAbility', 'logAppBundle', 'appName', 'collectLogs', 'logMaxBytes', 'serial', 'steps', 'timeoutMs', 'maxActions', 'maxModelCalls', 'runMode', 'verificationMode']; const patch = Object.fromEntries(allowed.filter(k => changes[k] !== undefined).map(k => [k, changes[k]])); const next = { ...job.args, ...patch }; if (changes.clearSteps === true) delete next.steps; return run(next, sessionId, model, signal, { parentRunId: id, relation: 'retry' }); },
    async dispose() { await logLibrary.dispose(); for (const job of jobs.values()) if (['queued', 'running'].includes(job.status)) job.controller.abort(new Error('DSH 正在关闭')); await Promise.allSettled([...jobs.values()].map(j => j.promise)); if (server) await new Promise(r => server.close(r)); },
  };
}
