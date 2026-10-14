"use client";
import { memo, useState } from "react";
import type { RoomActivity } from "@/lib/room-activity";
import { getRoomMemberName, type RoomMember } from "@/lib/room-types";
import { AliIcon } from "./AliIcon";
import { LazyMarkdownBody as MarkdownBody } from "./LazyMarkdownBody";
import { ChatDisclosure } from "./ChatDisclosure";
import styles from "./RoomWorkspace.module.css";

export const RoomActivityMessage = memo(function RoomActivityMessage({ activity, member, cwd, hasFinalReply, onBrowser, onMention }: {
  activity: RoomActivity; member?: RoomMember; cwd?: string; hasFinalReply: boolean;
  onBrowser: (sessionId: string) => void; onMention: (name: string) => void;
}) {
  const name = member ? getRoomMemberName(member) : "智能体";
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const [expandedTools, setExpandedTools] = useState<Set<string>>(() => new Set());
  const isStreaming = activity.status === "working";
  return <article className={`${styles.message} ${styles.activityMessage}`} data-room-activity={activity.runId} aria-label={`${name}的执行过程`}>
    <span className={styles.avatar}>{name.slice(0, 1)}</span>
    <div className={styles.messageColumn}>
      <div className={styles.messageMeta}><strong>{name}</strong><span>{activity.phase}</span></div>
      <div className="message-assistant-blocks">
        {activity.thinking ? <ChatDisclosure className="thinking-block" triggerClassName="thinking-block-trigger"
          expanded={thinkingExpanded} onExpandedChange={setThinkingExpanded} icon="brain" label="思考过程">
          <div className="thinking-block-content"><MarkdownBody cwd={cwd} className="markdown-thinking" isStreaming={isStreaming}>{activity.thinking}</MarkdownBody></div>
        </ChatDisclosure> : null}
        {activity.tools.map((tool) => <ChatDisclosure key={tool.id} label={tool.name}
          expanded={expandedTools.has(tool.id)} onExpandedChange={(expanded) => setExpandedTools((current) => {
            const next = new Set(current);
            if (expanded) next.add(tool.id); else next.delete(tool.id);
            return next;
          })}
          metadata={<span className={`chat-disclosure-status${tool.status === "error" ? " is-error" : tool.status === "running" && isStreaming ? " is-running" : ""}`}>
            {tool.status === "running" ? isStreaming ? "执行中" : "未完成" : tool.status === "error" ? "失败" : "已完成"}
          </span>}>
          <pre className={styles.toolOutput}>{tool.input}</pre>{tool.output ? <pre className={styles.toolOutput}>{tool.output}</pre> : null}
        </ChatDisclosure>)}
        {activity.text && !hasFinalReply ? <MarkdownBody cwd={cwd} className="markdown-assistant-message" isStreaming={isStreaming}>{activity.text}</MarkdownBody> : null}
        {!activity.text && !activity.thinking && !activity.tools.length ? <p className={styles.stageHint}>正在处理，执行步骤会显示在这里。</p> : null}
      </div>
      <div className={styles.liveActions}>
        <button type="button" onClick={() => onMention(name)}>补充指令</button>
        <button type="button" onClick={() => onBrowser(activity.sessionId)}><AliIcon name="earth" size={13} />查看浏览器</button>
      </div>
    </div>
  </article>;
});
