/**
 * Build-time fallback when the paired dshE2E source is not next to this plugin.
 *
 * Session logs live in the dshE2E log library, so this pane must never become a
 * second, reduced implementation. Without the paired source the honest result is
 * an explicit notice plus the build-time warning from scripts/build.mjs.
 */
export function LogWorkbench({ sessionId }: { visible?: boolean; sessionId?: string; onDraft?: (text: string) => void; openFileId?: string }) {
  if (!sessionId) return <p role="status">打开一个会话后即可管理会话日志。</p>;
  return <section aria-label="会话日志未配套">
    <p role="alert">
      当前构建没有找到配套的 dshE2E 源码，因此无法显示完整的会话日志工作台（导入、删除、改名、AI 分析、分页）。
      请把 <code>plugin/dsh-e2e</code> 与本插件放在同一个仓库下重新构建，并在完整重启宿主后成对使用。
    </p>
  </section>;
}
