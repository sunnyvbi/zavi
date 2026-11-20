export function refineDisplayText(goalGraph: unknown, fallback: string): string {
  const first = (Array.isArray(goalGraph) ? goalGraph[0] : null) as
    | { payload?: { user_request?: unknown } }
    | null;
  const words = first?.payload?.user_request;
  if (typeof words === "string" && words.trim()) return words.trim();
  const quoted = /the user'?s (?:exact )?words:\s*["“]([^"”]{2,1000})["”]/i.exec(fallback);
  if (quoted?.[1]) return quoted[1].trim();
  const head = fallback.split(/\n\s*\n/)[0]?.trim() ?? "";
  const sentence = /^(.{12,300}?[.!?])(?:\s|$)/.exec(head)?.[1];
  return (sentence ?? head ?? fallback).trim() || fallback;
}

export function userRequestFor(request: string | null | undefined, message: string): string | null {
  const words = (typeof request === "string" && request.trim() ? request : message).replace(/\s+/g, " ").trim();
  return words ? words.slice(0, 1000) : null;
}

export function refineAwaitsReview(goalGraph: unknown, merged = false): boolean {
  if (!Array.isArray(goalGraph)) return false;
  return goalGraph.some((node) => {
    const payload = (node as { payload?: { defer_pr?: unknown; stage?: unknown; awaiting_review?: unknown } } | null)?.payload;
    return !merged && (payload?.awaiting_review === true || payload?.defer_pr === true || payload?.stage === "refine_gate");
  });
}
