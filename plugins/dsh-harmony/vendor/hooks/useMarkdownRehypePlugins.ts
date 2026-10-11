"use client";

import { useEffect, useMemo, useState } from "react";
import type { Options as ReactMarkdownOptions } from "react-markdown";
import { markdownPreviewRehypePlugins, markdownRehypePlugins } from "@/lib/markdown";

type KatexPlugin = (typeof import("rehype-katex"))["default"];
type RawHtmlPlugin = (typeof import("rehype-raw"))["default"];

let loadedKatexPlugin: KatexPlugin | null = null;
let katexPluginPromise: Promise<KatexPlugin> | null = null;
let loadedRawHtmlPlugin: RawHtmlPlugin | null = null;
let rawHtmlPluginPromise: Promise<RawHtmlPlugin> | null = null;

function containsMath(markdown: string): boolean {
  return /(^|[^\\])\$\$?/m.test(markdown);
}

function containsRawHtml(markdown: string): boolean {
  return /<(?:!--|\/?[A-Za-z][^>]*>)/.test(markdown);
}

export function preloadMarkdownMathRenderer(): Promise<KatexPlugin> {
  if (!katexPluginPromise) {
    const pending = import("rehype-katex").then((module) => {
      loadedKatexPlugin = module.default;
      return module.default;
    });
    katexPluginPromise = pending;
    void pending.catch(() => {
      if (katexPluginPromise === pending) katexPluginPromise = null;
    });
  }
  return katexPluginPromise;
}

export function preloadMarkdownRawHtmlParser(): Promise<RawHtmlPlugin> {
  if (!rawHtmlPluginPromise) {
    const pending = import("rehype-raw").then((module) => {
      loadedRawHtmlPlugin = module.default;
      return module.default;
    });
    rawHtmlPluginPromise = pending;
    void pending.catch(() => {
      if (rawHtmlPluginPromise === pending) rawHtmlPluginPromise = null;
    });
  }
  return rawHtmlPluginPromise;
}

export function useMarkdownRehypePlugins(markdown: string, preview = false): ReactMarkdownOptions["rehypePlugins"] {
  const needsKatex = containsMath(markdown);
  const needsRawHtml = containsRawHtml(markdown);
  const [katexPlugin, setKatexPlugin] = useState<KatexPlugin | null>(() => loadedKatexPlugin);
  const [rawHtmlPlugin, setRawHtmlPlugin] = useState<RawHtmlPlugin | null>(() => loadedRawHtmlPlugin);

  useEffect(() => {
    if (!needsKatex || katexPlugin) return;
    let active = true;
    void preloadMarkdownMathRenderer().then((plugin) => {
      if (active) setKatexPlugin(() => plugin);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [katexPlugin, needsKatex]);

  useEffect(() => {
    if (!needsRawHtml || rawHtmlPlugin) return;
    let active = true;
    void preloadMarkdownRawHtmlParser().then((plugin) => {
      if (active) setRawHtmlPlugin(() => plugin);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [needsRawHtml, rawHtmlPlugin]);

  return useMemo(() => {
    const base = preview ? markdownPreviewRehypePlugins : markdownRehypePlugins;
    const plugins: NonNullable<ReactMarkdownOptions["rehypePlugins"]> = [
      ...(needsRawHtml && rawHtmlPlugin ? [rawHtmlPlugin] : []),
      ...base,
    ];
    if (needsKatex && katexPlugin) {
      plugins.push([katexPlugin, { throwOnError: false, strict: false }]);
    }
    return plugins;
  }, [katexPlugin, needsKatex, needsRawHtml, preview, rawHtmlPlugin]);
}
