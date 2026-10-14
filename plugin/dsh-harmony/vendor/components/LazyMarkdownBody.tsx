"use client";

import { lazy, Suspense } from "react";
import type { MarkdownBodyProps } from "./MarkdownBody";

const MarkdownBodyRenderer = lazy(() => (
  import("./MarkdownBody").then((module) => ({ default: module.MarkdownBody }))
));

/**
 * Keeps the full unified/remark/rehype stack out of the application shell.
 * The readable fallback also prevents message content from disappearing while
 * the renderer chunk is fetched for the first visible message.
 */
export function LazyMarkdownBody({ children, className, ...props }: MarkdownBodyProps) {
  return (
    <Suspense
      fallback={(
        <div
          className={["markdown-body", className].filter(Boolean).join(" ")}
          style={{ whiteSpace: "pre-wrap" }}
        >
          {children}
        </div>
      )}
    >
      <MarkdownBodyRenderer className={className} {...props}>{children}</MarkdownBodyRenderer>
    </Suspense>
  );
}
