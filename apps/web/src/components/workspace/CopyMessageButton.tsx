"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { cleanCopyMarkdown, markdownToPlainText } from "@/lib/workspace/replyCopy";
import { cx, FOCUS_RING, MESSAGE_ACTION_BUTTON, MESSAGE_ACTION_ICON } from "./layout/shared";

export const COPIED_MS = 1400;

function markdownToHtml(md: string): string {
  const host = document.createElement("div");
  const root = createRoot(host);
  flushSync(() => {
    root.render(
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
        {md}
      </ReactMarkdown>,
    );
  });
  const html = host.innerHTML;
  root.unmount();
  return html;
}

async function writeReply(markdown: string) {
  const origin = window.location.origin;
  const cleaned = cleanCopyMarkdown(markdown, origin);
  const plain = markdownToPlainText(cleaned, origin);
  try {
    if (typeof ClipboardItem === "undefined" || typeof navigator.clipboard.write !== "function") throw new Error("no rich clipboard");
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([markdownToHtml(cleaned)], { type: "text/html" }),
        "text/plain": new Blob([plain], { type: "text/plain" }),
      }),
    ]);
  } catch {
    await navigator.clipboard.writeText(plain);
  }
}

export function CopyMessageButton({ text, markdown }: { text?: string; markdown?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const onCopy = async () => {
    try {
      if (markdown === undefined) await navigator.clipboard.writeText(text ?? "");
      else await writeReply(markdown);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      type="button"
      onClick={(e) => {
        if (e.detail > 0) e.currentTarget.blur();
        void onCopy();
      }}
      aria-label={copied ? "Copied" : "Copy message"}
      title={copied ? "Copied" : "Copy"}
      className={cx(MESSAGE_ACTION_BUTTON, "text-inkMuted", FOCUS_RING)}
    >
      {copied ? <Check aria-hidden {...MESSAGE_ACTION_ICON} /> : <Copy aria-hidden {...MESSAGE_ACTION_ICON} />}
    </button>
  );
}
