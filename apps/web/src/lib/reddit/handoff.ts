export function redditSubmitUrl(subreddit: string): string {
  const sub = subreddit.replace(/^\/?r\//i, "").trim();
  return `https://www.reddit.com/r/${encodeURIComponent(sub)}/submit?type=TEXT`;
}

export type HandoffResult = { copied: boolean; opened: boolean };

function copy(text: string): Promise<boolean> {
  try {
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => false,
    );
  } catch {
    return Promise.resolve(false);
  }
}

function open(url: string): boolean {
  try {
    window.open(url, "_blank", "noopener,noreferrer");
    return true;
  } catch {
    return false;
  }
}

function handoff(url: string, text: string): Promise<HandoffResult> {
  const copying = copy(text);
  const opened = open(url);
  return copying.then((copied) => ({ copied, opened }));
}

export function copyReplyAndOpenThread(threadUrl: string, reply: string): Promise<HandoffResult> {
  return handoff(threadUrl, reply);
}

export function copyPostAndOpenComposer(subreddit: string, body: string): Promise<HandoffResult> {
  return handoff(redditSubmitUrl(subreddit), body);
}

export function pasteKeys(): string {
  const p = typeof navigator === "undefined" ? "" : `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`;
  return /Mac|iPhone|iPad/i.test(p) ? "⌘V" : "Ctrl+V";
}

export function replyPasteHint(copied: boolean): string {
  return copied
    ? `Reply copied. Opening the thread… On Reddit, click “Join the conversation”, press ${pasteKeys()}, read it over, then Comment.`
    : "Opening the thread… Your browser blocked the clipboard, so use Copy, then paste it into “Join the conversation”.";
}

export const handoffFallbackLabel = "Didn't open? Open it here";
