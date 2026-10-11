export async function rpc(operation, input = {}, signal) {
  const url = process.env.DSH_E2E_BRIDGE_URL;
  const token = process.env.DSH_E2E_BRIDGE_TOKEN;
  if (!url || !token) throw new Error('dshE2E 内部连接未配置');
  const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ operation, input }), signal });
  const value = await response.json();
  if (!response.ok) { const error = new Error(value.error?.message || 'dshE2E 内部调用失败'); error.code = value.error?.code; throw error; }
  return value;
}
