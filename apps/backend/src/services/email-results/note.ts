
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { rateOf, type WinLine } from "./win-line";
import { carriedNote, judgedOnCarried, type Route } from "./view";

export const DAY7_NOTE_CAP = 3;

type Day7Row = { id: string; d7_version: number; route: Route; subject: string; list_name: string | null; win_line: Partial<WinLine>; d7: Record<string, unknown>; verdict: string | null; note: string | null };

const pct = (x: number) => `${(x * 100).toFixed(x < 0.01 ? 2 : 1)}%`;

export function day7Line(r: Pick<Day7Row, "route" | "subject" | "list_name" | "win_line" | "d7" | "verdict" | "note">): string {
  const email = `Email "${r.subject.slice(0, 80)}"${r.list_name ? ` to ${r.list_name.slice(0, 60)}` : ""}`;
  const metric = r.win_line.metric ?? null;
  if (judgedOnCarried(r.d7, metric)) {
    const stopped = carriedNote(r.d7, r.route, r.note) ?? "Numbers stopped at 1 hour.";
    return `${email}: ${stopped} Zavi did not judge this email against the win line.`;
  }
  const what = `${email}, day 7`;
  const rate = metric ? rateOf(r.d7, metric) : null;
  const got = metric && rate !== null ? `${pct(rate)} ${metric === "visitors" ? "visited your site" : "clicked"}` : null;
  const bar = typeof r.win_line.threshold === "number" ? `win line ${pct(r.win_line.threshold)}` : null;
  switch (r.verdict) {
    case "beat":
      return `${what}: ${got}, ${bar}. Beat it.`;
    case "below":
      return `${what}: ${got}, ${bar}. Below it.`;
    case "baseline":
      return got ? `${what}: ${got}. This sets your baseline.` : `${what}: results are in. This sets your baseline.`;
    case "no_signal":
      return `${what}: results are in; no click or visitor signal to judge it on.`;
    default:
      return `${what}: results are in, but Zavi could not tell if it reached the win line.`;
  }
}

export type Day7Mark = { id: string; version: number };

export type Day7NoteDeps = {
  untold: (tenantId: string, limit: number) => Promise<Day7Row[]>;
  markTold: (tenantId: string, marks: Day7Mark[]) => Promise<void>;
};

const LIVE: Day7NoteDeps = {
  untold: async (tenantId, limit) => {
    const { data, error } = await tenantClient(asTenantId(tenantId))
      .from("email_send_results")
      .select("id, d7_version, route, subject, list_name, win_line, d7, verdict, note")
      .not("d7_published_at", "is", null)
      .is("d7_told_at", null)
      .order("d7_published_at", { ascending: true })
      .limit(limit);
    if (error) throw new Error("email_send_results read failed");
    return (data ?? []) as Day7Row[];
  },
  markTold: async (tenantId, marks) => {
    if (marks.length === 0) return;
    const { error } = await tenantRpc(asTenantId(tenantId), "mark_email_results_told", { p_marks: marks });
    if (error) throw new Error("mark_email_results_told failed");
  },
};

export async function day7NoteLines(tenantId: string, depsIn: Partial<Day7NoteDeps> = {}): Promise<{ lines: string[]; marks: Day7Mark[] }> {
  const deps = { ...LIVE, ...depsIn };
  try {
    const rows = await deps.untold(tenantId, DAY7_NOTE_CAP);
    return { lines: rows.map(day7Line), marks: rows.map((r) => ({ id: r.id, version: r.d7_version })) };
  } catch (e) {
    console.warn(`[email-results] day-7 note lines skipped for ${tenantId}: ${(e as Error).message}`);
    return { lines: [], marks: [] };
  }
}

export async function markDay7Told(tenantId: string, marks: Day7Mark[], depsIn: Partial<Day7NoteDeps> = {}): Promise<void> {
  const deps = { ...LIVE, ...depsIn };
  await deps.markTold(tenantId, marks).catch((e) => console.warn(`[email-results] day-7 lines not marked told for ${tenantId}: ${(e as Error).message}`));
}
