export function redactLog(text, secrets = []) {
  let value = String(text ?? '').slice(0, 8192);
  for (const secret of secrets.filter(s => typeof s === 'string' && s.length > 3)) value = value.replaceAll(secret, '[redacted]');
  return value.replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [redacted]')
    .replace(/((?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|cookie)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]');
}
