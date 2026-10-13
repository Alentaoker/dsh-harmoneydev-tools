const runFields = ['goal', 'expectation', 'name', 'appBundle', 'appAbility', 'logAppBundle', 'appName', 'collectLogs', 'logMaxBytes', 'serial', 'timeoutMs', 'maxActions', 'maxModelCalls', 'steps', 'runMode', 'verificationMode'];
const logFields = ['id', 'offset', 'limit', 'level', 'query', 'tag', 'domain', 'pid', 'tid', 'regex', 'caseSensitive', 'fullMessage', 'from', 'until'];
const operations = { status: [], resolve_app: ['query', 'appName', 'name', 'serial', 'offset', 'limit'], run: runFields, list_runs: ['offset', 'limit', 'query'], get_report: ['id'], get_logs: logFields, list_log_files: ['offset', 'limit'], get_file_logs: logFields, replay: ['id'], retry: ['id', 'clearSteps', ...runFields], cancel: ['id'] };
export function validateToolCall(args) {
  const fields = operations[args?.operation];
  if (!fields) throw Error('不支持的 E2E 操作');
  for (const key of Object.keys(args)) if (key !== 'operation' && !fields.includes(key)) throw Error(`${args.operation} 不接受字段 ${key}；请查看该操作的参数契约。`);
}
export function operationSchema(schema) {
  return { ...schema, anyOf: Object.entries(operations).map(([operation, fields]) => ({
    type: 'object', properties: { operation: { type: 'string', const: operation }, ...Object.fromEntries(fields.map(key => [key, schema.properties[key]])) },
    required: ['operation', ...(operation === 'run' ? ['goal'] : []), ...(['get_report','get_logs','get_file_logs','replay','retry','cancel'].includes(operation) ? ['id'] : [])],
    additionalProperties: false, ...(operation === 'run' ? { anyOf: [{ required:['steps'] }, { required:['expectation'] }] } : {}),
  })) };
}
export function resolveAppQuery(args) {
  const values = ['query', 'appName', 'name'].filter(key => args[key] !== undefined).map(key => {
    if (typeof args[key] !== 'string' || args[key].length > 256) throw Error(`${key} 必须是最多256字符的应用查询词`);
    return args[key].trim();
  });
  if (new Set(values).size > 1) throw Error('query/appName/name 查询词冲突，请只提供一个查询词');
  return values[0] ?? '';
}
