"use client";

import { useState } from "react";
import {
  readPromptOptimizerModel,
  readPromptOptimizerSystemPrompt,
} from "@/lib/prompt-optimizer-settings";
import { AliIcon } from "./AliIcon";
import styles from "./RoomSettingsDialog.module.css";

interface Props {
  label: string;
  help: string;
  purpose: string;
  value: string;
  onChange: (value: string) => void;
  cwd?: string;
  rows?: number;
  maxLength?: number;
  placeholder?: string;
  className?: string;
}

interface ModelsPayload {
  modelList?: Array<{ provider: string; id: string }>;
  defaultModel?: { provider: string; modelId: string } | null;
}

export function AITextAreaField({ label, help, purpose, value, onChange, cwd, rows = 3, maxLength, placeholder, className = "" }: Props) {
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const optimize = async () => {
    const source = value.trim();
    if (!source || loading) return;
    setLoading(true);
    setError(null);
    setPreview(null);
    try {
      const modelsResponse = await fetch(`/api/models${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`, { cache: "no-store" });
      const models = await modelsResponse.json() as ModelsPayload;
      const configured = readPromptOptimizerModel(window.localStorage);
      const selected = configured && models.modelList?.some((model) => model.provider === configured.provider && model.id === configured.modelId)
        ? configured
        : models.defaultModel;
      if (!selected) throw new Error("没有可用的文案优化模型，请先在“设置 → 对话”中配置模型。");
      const baseInstructions = readPromptOptimizerSystemPrompt(window.localStorage);
      const response = await fetch("/api/prompts/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: source,
          provider: selected.provider,
          modelId: selected.modelId,
          cwd,
          systemPrompt: `${baseInstructions}\n\n当前要优化的是“${purpose}”字段。请使用简洁、自然、可直接保存的中文扩写用户的简短描述；明确目标、职责、边界和可验证结果，但不得虚构项目事实或擅自改变原意。只返回优化后的字段内容。`,
        }),
      });
      const data = await response.json().catch(() => ({})) as { optimizedPrompt?: string; error?: string };
      if (!response.ok || !data.optimizedPrompt?.trim()) throw new Error(data.error || "AI 优化失败，请稍后重试。");
      setPreview(data.optimizedPrompt.trim());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  return <label className={`${styles.field}${className ? ` ${className}` : ""}`}>
    <span className={styles.aiFieldHeading}><span>{label}</span><button type="button" aria-label={`AI 优化${label}`} disabled={!value.trim() || loading} onClick={() => { void optimize(); }}>
      <AliIcon name="sparkles" size={13} />{loading ? "正在优化…" : "AI 优化"}
    </button></span>
    <small>{help}</small>
    <textarea value={value} onChange={(event) => { onChange(event.target.value); setPreview(null); setError(null); }} rows={rows} maxLength={maxLength} placeholder={placeholder} />
    {error ? <small className={styles.aiFieldError} role="alert">{error}</small> : null}
    {preview ? <div className={styles.aiPreview}>
      <div><AliIcon name="sparkles" size={13} /><strong>优化结果预览</strong></div>
      <p>{preview}</p>
      <div className={styles.aiPreviewActions}>
        <button type="button" onClick={() => setPreview(null)}>保留原文</button>
        <button type="button" className={styles.primary} onClick={() => { onChange(preview); setPreview(null); }}>采用优化结果</button>
      </div>
    </div> : null}
  </label>;
}
