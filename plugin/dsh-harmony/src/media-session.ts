import { createContext } from 'react';

export const MediaSessionContext = createContext<{ prepareAttachment?: () => (file: File) => Promise<void> }>({});

/** Capture the destination before asynchronous image rendering or media loading. */
export function prepareMediaAttachment(ctx: any, sessionId?: string) {
  const scope = sessionId && ctx.sessions.scope(sessionId);
  if (!scope) throw Error('请先打开要加入图片的会话');
  const input = ctx.conversation.input.for(scope);
  const conversation = ctx.conversation;
  if (typeof conversation.createDrafts !== 'function' || typeof input.addAttachments !== 'function') throw Error('当前宿主缺少图片草稿接口，请使用配套 DSH 版本并完整重启');
  return async (file: File) => {
    if (!ctx.sessions.scope(sessionId)) throw Error('目标会话已关闭，请重新选择会话');
    const snapshot = input.state?.getSnapshot?.();
    if (snapshot?.phase && snapshot.phase !== 'plain') throw Error('目标输入框正在处理请求，请稍后加入图片');
    if (!file.size || file.size > 20 * 1024 * 1024 || file.type !== 'image/png') throw Error('请选择 20 MiB 以内的 PNG 图片');
    const drafts = conversation.createDrafts(sessionId, [file]);
    if (!input.addAttachments(drafts.map((draft: any) => draft.id))) {
      conversation.releaseDraftAttachments?.(drafts);
      throw Error('图片未加入：目标输入框忙碌，请稍后重试');
    }
    input.focus?.();
  };
}
