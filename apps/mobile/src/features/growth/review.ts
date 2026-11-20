
export type ReviewAction = {
  id: string;
  channel_slug: string;
  title: string;
  status: string;
  snoozed_until?: string | null;
  executable?: boolean;
  blocking?: boolean;
  body?: {
    step?: { title?: string; body?: string; effort?: string; deliverable?: { content?: string } };
    findings?: unknown[];
  } | null;
};

export const EFFORT_LABEL: Record<string, string> = { minutes: "Minutes", hours: "Hours", days: "Days" };

export function firstSentence(text: string | undefined | null): string {
  const t = (text ?? "").trim();
  if (!t) return "";
  const m = t.match(/^[\s\S]*?[.!?](?=\s|$)/);
  return (m ? m[0] : t).replace(/\s+/g, " ").trim();
}

export function arrangeReview<T extends ReviewAction>(
  actions: readonly T[],
  compare: (a: T, b: T) => number,
): { top: T | null; quick: T[]; longer: T[] } {
  const ranked = [...actions].sort(compare);
  const [top = null, ...rest] = ranked;
  return {
    top,
    quick: rest.filter((a) => a.body?.step?.effort === "minutes"),
    longer: rest.filter((a) => a.body?.step?.effort !== "minutes"),
  };
}

export function beforeYouDoIt(body: ReviewAction["body"] | Record<string, unknown> | undefined | null): Array<[string, string]> {
  const findings = (body as { findings?: unknown[] } | null | undefined)?.findings;
  const first = Array.isArray(findings) ? findings[0] : null;
  if (!first || typeof first !== "object") return [];
  const f = first as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return (
    [
      ["Risk", text(f.risk)],
      ["Undo", text(f.undo)],
      ["If you skip it", text(f.do_nothing)],
    ] as Array<[string, string | null]>
  ).filter((row): row is [string, string] => row[1] !== null);
}
