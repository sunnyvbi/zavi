
import { DOGFOOD_SLUGS } from "@/services/tenants/new-tenant-alert";

export const RUN_COST_USD = 0.65;
export const MAX_RUNS_CAP = 230;

export type RerunArgs = { apply: boolean; maxRuns: number | null; tenant: string | null; channel: string | null };

export function parseRerunArgs(argv: readonly string[]): RerunArgs | { error: string } {
  const val = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i > -1 && i + 1 < argv.length ? argv[i + 1] : null;
  };
  const apply = argv.includes("--apply");
  const rawMax = val("--max-runs");
  let maxRuns: number | null = null;
  if (argv.includes("--max-runs")) {
    if (rawMax === null || !/^[1-9][0-9]*$/.test(rawMax)) return { error: "--max-runs needs a whole number above 0" };
    maxRuns = Number(rawMax);
    if (maxRuns > MAX_RUNS_CAP) return { error: `--max-runs ${maxRuns} is over the ${MAX_RUNS_CAP}-run cap ($150)` };
  }
  if (apply && maxRuns === null) return { error: "--apply needs --max-runs <n> (at most 230)" };
  const tenant = val("--tenant");
  if (argv.includes("--tenant") && !(tenant && /^[0-9a-f-]{36}$/i.test(tenant))) return { error: "--tenant needs a workspace id" };
  const channel = val("--channel");
  if (argv.includes("--channel") && !(channel && /^[a-z0-9_]+$/.test(channel))) return { error: "--channel needs a channel slug" };
  return { apply, maxRuns, tenant, channel };
}

export type Workspace = { id: string; slug: string | null; kind: string | null; deleted_at: string | null };
export type PreviewRun = {
  id: string;
  tenant_id: string;
  agent_slug: string;
  status: string;
  cron_dedupe_key: string;
  preview_action_types: string[] | null;
};

export type SelectionInput = {
  enrolled: ReadonlySet<string>;
  workspaces: readonly Workspace[];
  previewRuns: readonly PreviewRun[];
  openCards: ReadonlySet<string>;
  usedChannels: ReadonlySet<string>;
  tenant: string | null;
  channel: string | null;
};

export type Target = { tenant_id: string; slug: string | null; channel: string; run_id: string };
export type Skip = { tenant_id: string; channel: string; reason: "open_cards" | "used" };

const LIVE = new Set(["queued", "running"]);

export function rerunsInFlight(previewRuns: readonly PreviewRun[]): PreviewRun[] {
  const retired = new Set(
    previewRuns.filter((r) => r.cron_dedupe_key.startsWith("first-run-preview-done:")).map((r) => `${r.tenant_id}:${r.agent_slug}`),
  );
  return previewRuns.filter(
    (r) => r.cron_dedupe_key.startsWith("first-run-preview:") && LIVE.has(r.status) && retired.has(`${r.tenant_id}:${r.agent_slug}`),
  );
}

export function selectRerunTargets(input: SelectionInput): { targets: Target[]; skipped: Skip[] } {
  const ws = new Map(input.workspaces.map((w) => [w.id, w]));
  const targets: Target[] = [];
  const skipped: Skip[] = [];
  const runs = [...input.previewRuns].sort((a, b) => (a.tenant_id + a.agent_slug < b.tenant_id + b.agent_slug ? -1 : 1));
  for (const r of runs) {
    if (!r.cron_dedupe_key.startsWith(`first-run-preview:${r.tenant_id}:`)) continue;
    if (input.tenant && r.tenant_id !== input.tenant) continue;
    if (input.channel && r.agent_slug !== input.channel) continue;
    const w = ws.get(r.tenant_id);
    if (!w || !input.enrolled.has(r.tenant_id)) continue;
    if (w.kind === "test" || w.deleted_at || (w.slug && DOGFOOD_SLUGS.has(w.slug))) continue;
    if (r.status !== "success" || !Array.isArray(r.preview_action_types) || r.preview_action_types.length === 0) continue;
    const key = `${r.tenant_id}:${r.agent_slug}`;
    if (input.openCards.has(key)) {
      skipped.push({ tenant_id: r.tenant_id, channel: r.agent_slug, reason: "open_cards" });
      continue;
    }
    if (input.usedChannels.has(key)) {
      skipped.push({ tenant_id: r.tenant_id, channel: r.agent_slug, reason: "used" });
      continue;
    }
    targets.push({ tenant_id: r.tenant_id, slug: w.slug, channel: r.agent_slug, run_id: r.id });
  }
  return { targets, skipped };
}

export function refusalReason(args: { switchOn: boolean; inFlight: number }): string | null {
  if (!args.switchOn) return "signup_preview_real_cards is OFF: the re-runs would be dry again. Turn it on first.";
  if (args.inFlight > 0) return `${args.inFlight} re-run(s) from an earlier invocation are still queued or running. Wait for them.`;
  return null;
}
