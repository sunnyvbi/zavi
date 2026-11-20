
import { staffCrossTenantClient } from "@/services/tenant-client";
import { getBoolSettingStrictResolved } from "@/services/settings";
import { OPEN_CHANNEL_ACTIONS_VIEW } from "@/services/channels/open-actions-count";
import { rerunDryPreviews } from "@/services/growth/preview-upgrade";
import {
  RUN_COST_USD,
  parseRerunArgs,
  refusalReason,
  rerunsInFlight,
  selectRerunTargets,
  type PreviewRun,
  type Workspace,
} from "@/services/growth/rerun-dry-signup-previews";

const READ_CAP = 5000;
const ANY_TENANT = "00000000-0000-0000-0000-000000000000";

async function main(): Promise<number> {
  const args = parseRerunArgs(process.argv.slice(2));
  if ("error" in args) {
    console.error(args.error);
    return 2;
  }
  const db = staffCrossTenantClient("scripts/rerun-dry-signup-previews: re-run count-only signup rounds, Ravi-run");

  const [seq, tenants, runs, open, own] = await Promise.all([
    db.from("onboarding_email_sequence").select("tenant_id").limit(READ_CAP),
    db.from("tenants").select("id, slug, kind, deleted_at").limit(READ_CAP),
    db
      .from("agent_runs")
      .select("id, tenant_id, agent_slug, status, cron_dedupe_key, preview_action_types")
      .like("cron_dedupe_key", "first-run-preview%")
      .limit(READ_CAP),
    db.from(OPEN_CHANNEL_ACTIONS_VIEW).select("tenant_id, channel_slug").limit(READ_CAP * 4),
    db.from("agent_runs").select("tenant_id, channel_slug").is("cron_dedupe_key", null).not("channel_slug", "is", null).limit(READ_CAP * 4),
  ]);
  for (const r of [seq, tenants, runs, open, own]) if (r.error) throw new Error(`read failed: ${r.error.message}`);

  const previewRuns = (runs.data ?? []) as PreviewRun[];
  const switchOn = await getBoolSettingStrictResolved("signup_preview_real_cards", ANY_TENANT);
  const refusal = refusalReason({ switchOn, inFlight: rerunsInFlight(previewRuns).length });
  if (refusal) {
    console.error(`REFUSED: ${refusal}`);
    return 3;
  }

  const pair = (r: { tenant_id: string; channel_slug: string | null }) => `${r.tenant_id}:${r.channel_slug}`;
  const { targets, skipped } = selectRerunTargets({
    enrolled: new Set(((seq.data ?? []) as Array<{ tenant_id: string }>).map((r) => r.tenant_id)),
    workspaces: (tenants.data ?? []) as Workspace[],
    previewRuns,
    openCards: new Set(((open.data ?? []) as Array<{ tenant_id: string; channel_slug: string | null }>).map(pair)),
    usedChannels: new Set(((own.data ?? []) as Array<{ tenant_id: string; channel_slug: string | null }>).map(pair)),
    tenant: args.tenant,
    channel: args.channel,
  });

  const limit = args.maxRuns ?? targets.length;
  const planned = targets.slice(0, limit);
  console.log(`Would start ${planned.length} run(s) of ${targets.length} candidate(s); estimate $${(planned.length * RUN_COST_USD).toFixed(2)}.`);
  for (const t of planned) console.log(`  start  ${t.tenant_id} (${t.slug ?? "?"})  ${t.channel}`);
  for (const s of skipped) console.log(`  skip   ${s.tenant_id}  ${s.channel}  (${s.reason})`);
  if (!args.apply) {
    console.log("Dry run: nothing started. Add --apply --max-runs <n> to run.");
    return 0;
  }

  let started = 0;
  const byTenant = new Map<string, Set<string>>();
  for (const t of planned) byTenant.set(t.tenant_id, (byTenant.get(t.tenant_id) ?? new Set()).add(t.channel));
  for (const [tenant_id, channels] of byTenant) {
    if (started >= limit) break;
    try {
      const out = await rerunDryPreviews(tenant_id, {
        include: async (r) => channels.has(r.agent_slug),
        maxStarts: limit - started,
      });
      started += out.started.length;
      console.log(`  ${tenant_id}: started [${out.started.join(", ")}] retry [${out.retry.join(", ")}] refused [${out.refused.join(", ")}]`);
    } catch (e) {
      console.error(`  ${tenant_id}: FAILED ${(e as Error).message}`);
    }
  }
  console.log(`Started ${started} run(s), about $${(started * RUN_COST_USD).toFixed(2)}.`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
