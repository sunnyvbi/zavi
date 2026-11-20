
export type CheckStatus = "pass" | "fix" | "unknown";

export type ChecklistRow = {
  key: string;
  label: string;
  status: CheckStatus;
  statusLabel: string;
  note: string;
  fix: { kind: "link"; label: string; url: string } | { kind: "chat"; label: string; draft: string } | null;
};

export type XChecklist = { rows: ChecklistRow[]; caption: string | null; empty: string };

const TODO_LABEL: Record<string, string> = {
  cadence: "Post at least 3 times a week",
  reply_rate: "Reply to at least half the replies you get",
};

const RANK: Record<CheckStatus, number> = { fix: 0, unknown: 1, pass: 2 };
const STATUS_LABEL: Record<CheckStatus, string> = { pass: "Passing", unknown: "No data yet", fix: "To do" };

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (v && typeof v === "object" ? (v as Rec) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const https = (v: unknown): string | null => {
  const s = str(v);
  return s && /^https:\/\/[^\s/]+(\/\S*)?$/i.test(s.trim()) ? s.trim() : null;
};

export function fixDraft(label: string, note: string): string {
  return `Help me fix this on my X profile: ${label}. Right now: ${note}. Tell me exactly what to do, and draft it for me.`;
}

export function xChecklist(payload: unknown): XChecklist | null {
  const d = rec(payload);
  const c = rec(d?.checklist);
  if (!d || !c) return null;
  const signals = (Array.isArray(c.signals) ? (c.signals as unknown[]) : []).map(rec).filter((s): s is Rec => !!s);
  const rows: ChecklistRow[] = signals
    .map((s, i) => ({ s, i }))
    .map(({ s, i }) => {
      const status: CheckStatus = s.status === "fix" ? "fix" : s.status === "unknown" ? "unknown" : "pass";
      const key = str(s.key) ?? `check-${i}`;
      const label = (status === "fix" && TODO_LABEL[key]) || str(s.label) || key;
      const note = str(s.note) ?? "";
      const link = https(s.link);
      const fix: ChecklistRow["fix"] =
        status !== "fix"
          ? null
          : link
            ? { kind: "link", label: "Fix on X", url: link }
            : { kind: "chat", label: "Fix with Zavi", draft: fixDraft(label, note) };
      return { i, row: { key, label, status, statusLabel: STATUS_LABEL[status], note, fix } };
    })
    .sort((a, b) => RANK[a.row.status] - RANK[b.row.status] || a.i - b.i)
    .map((x) => x.row);
  const passed = typeof c.passed === "number" ? c.passed : null;
  const total = typeof c.total === "number" ? c.total : null;
  return {
    rows,
    caption: passed !== null && total !== null ? `${passed} of ${total} checks passing.` : null,
    empty: "Zavi has not checked this profile yet.",
  };
}
