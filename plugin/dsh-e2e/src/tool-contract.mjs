// Operation contract for the dshVerify tool.
//
// The old execution operations are declared on purpose: an old prompt should get
// an explicit migration error instead of an opaque schema rejection.
export const retirements = {
  run: '旧内层执行器已移除',
  replay: '动作回放已移除',
  retry: '旧复测执行器已移除',
  cancel: '旧运行取消已移除',
  archive: '旧执行记录归档已退役',
};

const deviceFields = ['serial', 'appBundle', 'appName', 'logAppBundle', 'logMaxBytes', 'collectLogs', 'device'];
const logFields = ['id', 'offset', 'limit', 'level', 'query', 'bundle', 'tag', 'domain', 'pid', 'tid', 'regex', 'caseSensitive', 'fullMessage', 'from', 'until'];

export const operations = {
  status: [],
  resolve_app: ['query', 'appName', 'name', 'serial', 'offset', 'limit'],
  save_task: ['taskId', 'revision', 'title', 'kind', 'requirement', 'logRefs', 'codeHints', 'changes', 'checkpoints', 'installHandoff', 'handoffStatus'],
  begin_validation: ['taskId', 'mode', 'serial', 'installationConfirmed', 'verifyExisting', 'installedRevision', 'device', 'checkpoints'],
  record_checkpoint: ['taskId', 'attemptId', 'checkpointId', 'result', 'summary', 'evidence', 'source'],
  finish_validation: ['taskId', 'attemptId', 'note', 'overall', 'evidenceGaps'],
  read_validation: ['taskId', 'attemptId', 'afterSeq', 'limit', 'format', 'legacyOnly', 'includeLegacy', 'query', 'offset'],
  cancel_validation: ['taskId', 'attemptId', 'reason'],
  start_capture: ['serial', 'taskId', 'attemptId', 'appBundle', 'appName', 'logAppBundle', 'logMaxBytes'],
  stop_capture: ['captureId', 'taskId', 'attemptId'],
  attach_capture: ['captureId', 'taskId', 'attemptId'],
  list_runs: ['offset', 'limit', 'query'],
  get_report: ['id'],
  get_logs: logFields,
  list_log_files: ['offset', 'limit', 'query'],
  get_file_logs: [...logFields, 'lineFrom', 'lineUntil'],
};

export const retiredFields = {
  run: [...deviceFields, 'goal', 'expectation', 'name', 'appAbility', 'timeoutMs', 'maxActions', 'maxModelCalls', 'steps', 'runMode', 'verificationMode'],
  replay: ['id'],
  retry: ['id', 'clearSteps', ...deviceFields, 'goal', 'expectation', 'name', 'appAbility', 'timeoutMs', 'maxActions', 'maxModelCalls', 'steps', 'runMode', 'verificationMode'],
  cancel: ['id'],
  archive: ['id', 'archived'],
};

export function validateToolCall(args) {
  if (retirements[args?.operation]) {
    for (const key of Object.keys(args)) {
      if (key !== 'operation' && !(retiredFields[args.operation] || []).includes(key)) throw Error(`${args.operation} 不接受字段 ${key}；请查看该操作的参数契约。`);
    }
    return args;
  }
  const fields = operations[args?.operation];
  if (!fields) throw Error('不支持的 dshVerify 操作；旧执行操作 run/replay/retry/cancel/archive 已退役，请查看迁移说明');
  for (const key of Object.keys(args)) if (key !== 'operation' && !fields.includes(key)) throw Error(`${args.operation} 不接受字段 ${key}；请查看该操作的参数契约。`);
  return args;
}

export function operationSchema(schema) {
  const required = operation => [
    'begin_validation', 'record_checkpoint', 'finish_validation', 'cancel_validation',
  ].includes(operation) ? ['taskId'] : [];
  const branches = Object.entries({ ...operations, ...retirements }).map(([operation]) => ({
    type: 'object',
    properties: {
      operation: { type: 'string', const: operation },
      ...Object.fromEntries((operations[operation] || retiredFields[operation] || []).filter(key => schema.properties[key]).map(key => [key, schema.properties[key]])),
    },
    required: ['operation', ...required(operation), ...(['get_report', 'get_logs', 'get_file_logs'].includes(operation) ? ['id'] : [])],
    additionalProperties: false,
  }));
  return { ...schema, anyOf: branches };
}

export function resolveAppQuery(args) {
  const values = ['query', 'appName', 'name'].filter(key => args[key] !== undefined).map(key => {
    if (typeof args[key] !== 'string' || args[key].length > 256) throw Error(`${key} 必须是最多256字符的应用查询词`);
    return args[key].trim();
  });
  if (new Set(values).size > 1) throw Error('query/appName/name 查询词冲突，请只提供一个查询词');
  return values[0] ?? '';
}
