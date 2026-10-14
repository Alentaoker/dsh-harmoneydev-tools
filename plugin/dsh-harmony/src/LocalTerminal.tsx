import React from 'react';
export function SmartShellPanel() {
  return <div style={{ padding: 12 }}><p>本机终端使用 dsh 原生终端。</p><button onClick={() => window.dispatchEvent(new Event('dshHarmony:terminal'))}>打开本机终端</button></div>;
}
