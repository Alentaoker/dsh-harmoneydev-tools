import { mkdirSync } from 'node:fs';
import { setHost, dataRoot } from './state';
import pioraHarmony from '../vendor/extensions/piora-harmony';
import { getHarmonyDeviceManager } from '../vendor/lib/harmony';
import { beginPromptRun, getActivePromptRun, finishPromptRun } from '../vendor/lib/prompt-run-registry';
import { routes } from './routes';
import { createTaskRouting, taskRoutingGuidance, isObservation } from './task-routing';
import { createValidationBridge, structuredHarmonyError, structuredToolFailure, humanObserve, humanScreenshot } from './validation-bridge';

export const name = 'dshHarmony';
export const inject = ['connection', 'sessions', 'llm', 'attachments'];

const leaseFreeObservations = new Set(['observe_screen', 'observe_page', 'take_screenshot']);

export function apply(ctx: any) {
  mkdirSync(dataRoot, { recursive: true });
  setHost(ctx);
  const taskRouting = createTaskRouting();
  // dshE2E is optional. It is read lazily through the service registry so that
  // installing only Harmony keeps working, and the two plugins cannot deadlock
  // each other's startup.
  const validation = createValidationBridge(() => (typeof ctx.reflect.get === 'function' ? ctx.reflect.get('dshE2E') : ctx.dshE2E)?.validation);
  const lastAttempt = new Map<string, { taskId: string; attemptId: string; runId?: string }>();
  let original: any, prompt = '';
  pioraHarmony({
    registerTool(tool: any) { original = tool; },
    on(_event: string, callback: any) { prompt = callback({ systemPrompt: '', systemPromptOptions: { selectedTools: ['harmony_control'] } }).systemPrompt; },
  } as any);

  async function harnessContent(blocks: any[]) {
    const content: any[] = [];
    for (const block of blocks) {
      if (block.type === 'image') {
        const attachment = await ctx.attachments.saveImage({ data: Buffer.from(block.data, 'base64'), mediaType: block.mimeType, name: 'Harmony screen.png' });
        content.push({ type: 'image', attachment });
      } else content.push(block);
    }
    return content;
  }
  async function serialFor(input: any, attempt: any, signal?: AbortSignal) {
    if (typeof input?.serial === 'string' && input.serial.trim()) return input.serial.trim();
    if (attempt?.serial) return attempt.serial;
    const online = (await getHarmonyDeviceManager().listDevices(signal)).filter((device: any) => device.state === 'online');
    if (online.length === 1) return online[0].serial;
    throw new Error('人工模式只读观察需要明确设备 serial（在线设备不唯一）');
  }

  const tool = {
    name: original.name, description: original.description,
    parameters: { type: 'object', properties: { operation: { type: 'string' }, topic: { type: 'string' }, input: { type: 'object', additionalProperties: {} }, execution: { type: 'string', enum: ['direct'], description: '明确选择不留 dshE2E 验证记录的直控时使用' }, directReason: { type: 'string', minLength: 1, maxLength: 500 } }, required: ['operation'], additionalProperties: false },
    executionMode: { kind: 'exclusive' },
    output: { schema: {}, render: (_args: any, value: any) => value.content, presentationMeta: (_args: any, value: any) => value.details },
    async execute(args: any, exec: any) {
      if (!exec.agent) throw new Error('dshHarmony requires an active Harness session');
      exec.signal.throwIfAborted();
      const sessionId = exec.agent.id;
      const decision = taskRouting.check(sessionId, args);
      const humanMode = decision.humanMode;
      const callId = exec.callId;
      if (!getActivePromptRun(sessionId)) beginPromptRun(sessionId);
      if (decision.attempt) lastAttempt.set(sessionId, { taskId: decision.attempt.taskId, attemptId: decision.attempt.attemptId, runId: getActivePromptRun(sessionId)?.runId });

      // Bind the device before any I/O: with a validation context the serial is
      // fixed by the attempt, and an explicit different serial is rejected.
      let callArgs = args;
      if (decision.attempt?.serial) {
        const requested = args.input?.serial;
        if (typeof requested === 'string' && requested && requested !== decision.attempt.serial) {
          throw new Error(`[SERIAL_MISMATCH] 本次调用要求设备 ${requested}，但当前验证轮次绑定的是 ${decision.attempt.serial}；请显式结束本轮后改用正确设备。`);
        }
        callArgs = { ...args, input: { ...(args.input || {}), serial: decision.attempt.serial } };
      }
      // Cancelling the validation attempt aborts the in-flight device call.
      const validationSignal = decision.attempt ? validation.attemptSignal(sessionId) : undefined;
      const signal = validationSignal ? AbortSignal.any([exec.signal, validationSignal]) : exec.signal;

      const observationOperations = new Set(['observe_screen', 'observe_page', 'take_screenshot']);
      if (decision.attempt && observationOperations.has(args.operation)) {
        // One protected observation: mask/save first, then convert the exact
        // same bytes into a host attachment through the existing adapter.
        const started = await validation.begin(sessionId, { callId, operation: args.operation, input: callArgs.input, humanMode });
        const serial = decision.attempt.serial || await serialFor(callArgs.input, decision.attempt, exec.signal);
        let endAttempted = false;
        try {
          const input = callArgs.input || {};
          const observed = args.operation === 'take_screenshot'
            ? await humanScreenshot(getHarmonyDeviceManager(), { serial, signal })
            : await humanObserve(getHarmonyDeviceManager(), {
              serial, operation: args.operation, signal,
              includeScreenshot: args.operation !== 'observe_page',
              cursor: input.cursor, limit: input.limit, selector: input.selector, ancestors: input.ancestors, region: input.region,
            });
          endAttempted = true;
          const ended = await validation.end(sessionId, started.context, { callId, operation: args.operation, result: observed, humanMode, observation: observed.details?._evidence });
          const details = { ...observed.details };
          delete details._evidence;
          const rawBlocks = [...observed.content];
          const evidenceNames = ended.evidence || [];
          const imageName = args.operation === 'take_screenshot' ? null : evidenceNames.find((name: string) => /\.png$/i.test(name)) || null;
          const imageBytes = imageName ? await validation.evidenceData(sessionId, started.context, imageName) : undefined;
          if (imageBytes) rawBlocks.push({ type: 'image', data: imageBytes.toString('base64'), mimeType: 'image/png' });
          let content: any[];
          try {
            content = await harnessContent(rawBlocks);
          } catch (error: any) {
            // Never return a raw image block: a failed attachment conversion is
            // an evidence gap, not an image the model saw.
            content = await harnessContent(observed.content);
            const gap = `受保护证据图片未能转换为宿主附件：${error.message}`;
            try { await validation.recordGap?.(sessionId, started.context, gap); } catch { /* keep the original gap */ }
            content.push({ type: 'text', text: `[EVIDENCE_GAP] ${gap}` });
            details.evidenceGap = gap;
          }
          const imageBlock = content.find((block: any) => block.type === 'image' && block.attachment);
          if (imageBlock && imageName) {
            const attachmentId = imageBlock.attachment?.id ?? imageBlock.attachment?.attachmentId ?? null;
            details.protectedEvidence = {
              name: imageName, attachment: imageBlock.attachment,
              ...(ended.evidenceMeta || {}),
              note: '模型看到的就是这份已脱敏并落盘的证据图片',
            };
            try { await validation.noteAttachment?.(sessionId, started.context, { name: imageName, attachmentId, mediaType: imageBlock.attachment?.mediaType }); }
            catch (error: any) { details.attachmentGap = error.message; }
          }
          if (ended.treeEvidence) details.treeEvidence = ended.treeEvidence;
          for (const gap of ended.gaps || []) content.push({ type: 'text', text: `[EVIDENCE_GAP] ${gap}` });
          if (ended.recorded !== true) content.push({ type: 'text', text: `[TRACE_GAP] 本次观察未写入验证记录：${ended.reason || '记录失败'}。` });
          details.validation = { taskId: decision.attempt.taskId, attemptId: decision.attempt.attemptId, callId, recorded: ended.recorded === true, evidence: ended.evidence || [], instruction: '可通过观察证据文件或该 callId 作为 record_checkpoint 的证据；工具成功不等于检查通过。' };
          return JSON.parse(JSON.stringify({ ...observed, details, content, execution: { kind: humanMode ? 'human-observe' : 'observation', validationRecorded: ended.recorded === true, controlLease: false, e2eRunCreated: false } }));
        } catch (error: any) {
          const structured = structuredHarmonyError(error);
          let recorded: any;
          if (!endAttempted) {
            endAttempted = true;
            recorded = await validation.end(sessionId, started.context, { callId, operation: args.operation, error: structured, humanMode });
          }
          const wrapped = Object.assign(new Error(`[${structured.code}] ${structured.message}`), structured);
          if (recorded && recorded.recorded !== true) wrapped.traceGap = { kind: 'validation-event-lost', reason: recorded?.reason || '记录失败', actionError: structured };
          throw wrapped;
        }
      }

      // A control action in an active attempt must be recordable before dispatch.
      let started: any = { recorded: false, context: null, reason: '当前会话没有进行中的验证轮次' };
      if (decision.attempt) {
        started = await validation.begin(sessionId, { callId, operation: args.operation, input: callArgs.input, humanMode });
        if (decision.mutating && !started.recorded) {
          throw new Error(`[TRACE_NOT_RECORDED] 无法在派发前记录本次动作（${started.reason || '记录失败'}）；按规则不执行控制动作，请先修复记录存储或结束验证轮次。`);
        }
      }

      if (decision.attempt && decision.mutating) {
        const run = getActivePromptRun(sessionId);
        try {
          await validation.beginControlAcquisition(sessionId, { ...decision.attempt, runId: run?.runId ?? null, ownerId: run?.runId ?? null, callId });
        } catch (error: any) {
          throw Object.assign(new Error(`[CONTROL_ACQUISITION_NOT_RECORDED] ${error.message}`), { code: 'CONTROL_ACQUISITION_NOT_RECORDED' });
        }
      }

      let result: any;
      try {
        result = await original.execute(exec.callId, callArgs, signal, undefined, { sessionManager: { getSessionId: () => sessionId } });
      } catch (error: any) {
        const structured = structuredHarmonyError(error);
        let recorded: any;
        if (decision.attempt) recorded = await validation.end(sessionId, started.context, { callId, operation: args.operation, error: structured, humanMode });
        const wrapped = Object.assign(new Error(`[${structured.code}] ${structured.message}`), structured);
        if (decision.attempt && recorded?.recorded !== true) wrapped.traceGap = { kind: 'validation-event-lost', reason: recorded?.reason || '记录失败', dispatchState: structured.dispatchState, effect: structured.effect };
        throw wrapped;
      }
      if (result.isError) {
        const structured = structuredToolFailure(result);
        let recorded: any;
        if (decision.attempt) recorded = await validation.end(sessionId, started.context, { callId, operation: args.operation, error: structured, humanMode });
        const wrapped = Object.assign(new Error(`[${structured.code}] ${structured.message}`), structured);
        if (decision.attempt && recorded?.recorded !== true) wrapped.traceGap = { kind: 'validation-event-lost', reason: recorded?.reason || '记录失败', dispatchState: structured.dispatchState, effect: structured.effect };
        throw wrapped;
      }

      let ended: any = { recorded: false, reason: '未记录' };
      if (decision.attempt) ended = await validation.end(sessionId, started.context, { callId, operation: args.operation, result, humanMode });
      const content = await harnessContent(result.content);
      const details = { ...(result.details || {}) };
      const traceGap = decision.attempt && ended.recorded !== true;
      for (const gap of ended.gaps || []) content.push({ type: 'text', text: `[EVIDENCE_GAP] ${gap}` });
      if (traceGap) {
        content.push({ type: 'text', text: `[TRACE_GAP] 设备调用的结果没有写入验证记录：${ended.reason || '记录失败'}。动作可能已提交，效果按未知处理，不要自动重发。` });
        details.traceGap = { kind: 'validation-event-lost', reason: ended.reason || '记录失败', dispatchState: 'unknown', effect: 'unknown', verification: 'unknown' };
      }
      if (decision.attempt) details.validation = { taskId: decision.attempt.taskId, attemptId: decision.attempt.attemptId, callId, recorded: ended.recorded === true, evidence: ended.evidence || [] };
      if (decision.attempt && args.operation === 'release_control') {
        try { await validation.confirmControlRelease(sessionId, { ...decision.attempt, released: true, source: 'release-control', runId: getActivePromptRun(sessionId)?.runId ?? null }); }
        catch (error: any) { details.controlReleaseError = error.message; }
      }
      if (!decision.attempt) content.push({ type: 'text', text: '本次调用没有进行中的 dshVerify 验证轮次，未创建验证记录；不要据此宣称功能已通过。' });
      if (args.execution === 'direct') content.push({ type: 'text', text: '本次为明确选择的 Harmony 直接调用：未创建 dshVerify 验证轮次，也没有独立的检查点结论。' });
      return JSON.parse(JSON.stringify({ ...result, details, content, execution: { kind: args.execution === 'direct' ? 'direct' : humanMode ? 'human-observe' : 'harmony', validationRecorded: started.recorded === true && !traceGap, traceGap: traceGap || undefined, e2eRunCreated: false } }));
    },
  };
  const release = ctx.reflect.provide('dshHarmony', { tool, prompt, taskRoutingGuidance, automation: {
    getManager: getHarmonyDeviceManager, taskRouting,
    async acquireForTask(options: any) {
      const identity = getActivePromptRun(options.owner.sessionId);
      const handoffFrom = identity ? { kind: 'agent' as const, id: identity.runId, sessionId: identity.sessionId } : undefined;
      const lease = await getHarmonyDeviceManager().acquireLease({ ...options, handoffFrom });
      if (identity) await finishPromptRun(identity, 'idle');
      return lease;
    },
  } });
  ctx.effect(() => release, 'dshHarmony: bridge');
  for (const route of routes) ctx.effect(() => ctx.connection.fetch.register(route), `dshHarmony: ${route.path}`);
  ctx.on('agent/turn-stopping', async ({ agent }: any) => {
    const identity = getActivePromptRun(agent.id);
    const outcome = await finishPromptRun(identity, 'idle');
    const active = lastAttempt.get(agent.id);
    if (active) {
      const released = outcome.matched === true && outcome.cleanupFailures === 0;
      try {
        await validation.confirmControlRelease(agent.id, {
          ...active,
          runId: outcome.matched ? outcome.runId : active.runId ?? null,
          released, source: 'prompt-run-idle',
          cleanupCount: outcome.cleanupCount, cleanupFailures: outcome.cleanupFailures,
          errorMessages: outcome.errorMessages,
          reason: outcome.matched ? (released ? null : 'PromptRun 控制清理失败') : '没有匹配的活动 PromptRun，未确认释放',
        });
      } catch { /* the attempt may already be gone; no lease claim is made */ }
      lastAttempt.delete(agent.id);
    }
  });
  ctx.on('session/disposed', async (session: any) => {
    const identity = getActivePromptRun(session.id);
    const outcome = await finishPromptRun(identity, 'destroy');
    const active = lastAttempt.get(session.id);
    if (active) {
      const released = outcome.matched === true && outcome.cleanupFailures === 0;
      try {
        await validation.confirmControlRelease(session.id, {
          ...active,
          runId: outcome.matched ? outcome.runId : active.runId ?? null,
          released, source: 'session-disposed',
          cleanupCount: outcome.cleanupCount, cleanupFailures: outcome.cleanupFailures,
          errorMessages: outcome.errorMessages,
          reason: outcome.matched ? (released ? null : 'PromptRun 控制清理失败') : '没有匹配的活动 PromptRun，未确认释放',
        });
      } catch { /* no lease claim when the service is already gone */ }
      lastAttempt.delete(session.id);
    }
  });
  ctx.effect(() => async () => {
    for (const session of ctx.sessions.list()) await finishPromptRun(getActivePromptRun(session.id), 'destroy');
    await getHarmonyDeviceManager().dispose();
  }, 'dshHarmony: cleanup');
}
