
import { CHANNELS } from "@zavi/shared";

export const CHATGPT_ADS = "chatgpt_ads";

export const AUTORUN_ROW_COLUMNS = "channel_slug, autorun, autorun_set_by, autorun_set_at, chatgpt_autopilot_consent_at";

export type AutorunRow = {
  channel_slug: string;
  autorun?: boolean | null;
  autorun_set_by?: string | null;
  autorun_set_at?: string | null;
  chatgpt_autopilot_consent_at?: string | null;
};

export type AutopilotState = {
  enabled: boolean;
  on_at: string | null;
};

export type AutorunReason = "autopilot_off" | "no_paid_consent" | "ask_first" | "autopilot";

export type AutorunResolution = {
  effective: boolean;
  stored: boolean;
  display: boolean;
  reason: AutorunReason;
};

const ts = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const frac = /:\d{2}\.(\d+)/.exec(iso)?.[1] ?? "";
  return ms * 1000 + Number((frac + "000000").slice(3, 6));
};

export function founderAskFirstSinceOn(row: AutorunRow | null | undefined, on_at: string | null): boolean {
  if (!row || row.autorun !== false || row.autorun_set_by !== "founder") return false;
  const setAt = ts(row.autorun_set_at);
  if (setAt === null) return false;
  const onAt = ts(on_at);
  if (onAt === null) return true;
  return setAt >= onAt;
}

export function resolveChannelAutorun(ap: AutopilotState, slug: string, row: AutorunRow | null | undefined): AutorunResolution {
  const consent = slug !== CHATGPT_ADS || !!row?.chatgpt_autopilot_consent_at;
  const stored = row?.autorun === true && consent;
  if (!ap.enabled) return { effective: false, stored, display: stored, reason: "autopilot_off" };
  if (!consent) return { effective: false, stored, display: false, reason: "no_paid_consent" };
  if (founderAskFirstSinceOn(row, ap.on_at)) return { effective: false, stored, display: false, reason: "ask_first" };
  return { effective: true, stored, display: true, reason: "autopilot" };
}

export type ChannelAutorunView = {
  autopilot: AutopilotState;
  rows: ReadonlyMap<string, AutorunRow>;
  resolve: (slug: string) => AutorunResolution;
  effectiveSet: () => Set<string>;
};

export function buildAutorunView(autopilot: AutopilotState, rows: readonly AutorunRow[]): ChannelAutorunView {
  const bySlug = new Map(rows.map((r) => [r.channel_slug, r]));
  const resolve = (slug: string) => resolveChannelAutorun(autopilot, slug, bySlug.get(slug));
  return {
    autopilot,
    rows: bySlug,
    resolve,
    effectiveSet: () => {
      if (!autopilot.enabled) return new Set();
      const slugs = new Set<string>([...CHANNELS.map((c) => c.slug), ...bySlug.keys()]);
      return new Set([...slugs].filter((s) => resolve(s).effective));
    },
  };
}

const DRIFT_TTL_MS = 60 * 60_000;
const driftSeen = new Map<string, number>();

export function noteAutorunDrift(tenant_id: string, slug: string, r: AutorunResolution, where: string): void {
  if (r.effective === r.stored) return;
  const key = `${tenant_id}:${slug}:${r.effective}:${r.reason}`;
  const now = Date.now();
  const last = driftSeen.get(key);
  if (last !== undefined && now - last < DRIFT_TTL_MS) return;
  driftSeen.set(key, now);
  if (driftSeen.size > 5000) driftSeen.clear();
  console.info(
    JSON.stringify({
      evt: "channel_autorun.effective_differs",
      tenant_id,
      channel_slug: slug,
      stored: r.stored,
      effective: r.effective,
      reason: r.reason,
      where,
    }),
  );
}

export function _resetAutorunDriftLog(): void {
  driftSeen.clear();
}

export async function readAutopilotState(tenant_id: string): Promise<AutopilotState> {
  const { getBoolSettingStrictResolved } = await import("@/services/settings");
  const enabled = await getBoolSettingStrictResolved("cgo_autopilot_enabled", tenant_id);
  if (!enabled) return { enabled: false, on_at: null };
  const { asTenantId, tenantClient } = await import("@/services/tenant-client");
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("cgo_autopilot_state")
    .select("on_at")
    .eq("tenant_id", tenant_id)
    .maybeSingle<{ on_at: string | null }>();
  if (error) throw new Error(`autopilot state read failed: ${error.message}`);
  if (!(await getBoolSettingStrictResolved("cgo_autopilot_enabled", tenant_id))) return { enabled: false, on_at: null };
  return { enabled: true, on_at: data?.on_at ?? null };
}

export async function readAutorunRows(tenant_id: string): Promise<AutorunRow[]> {
  const { asTenantId, tenantClient } = await import("@/services/tenant-client");
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("tenant_channels")
    .select(AUTORUN_ROW_COLUMNS)
    .eq("tenant_id", tenant_id);
  if (error) throw new Error(`autorun read failed: ${error.message}`);
  return (data ?? []) as unknown as AutorunRow[];
}

export async function readAutorunRow(tenant_id: string, slug: string): Promise<AutorunRow | null> {
  const { asTenantId, tenantClient } = await import("@/services/tenant-client");
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("tenant_channels")
    .select(AUTORUN_ROW_COLUMNS)
    .eq("tenant_id", tenant_id)
    .eq("channel_slug", slug)
    .maybeSingle();
  if (error) throw new Error(`autorun read failed: ${error.message}`);
  return (data ?? null) as unknown as AutorunRow | null;
}

async function stillOn(tenant_id: string): Promise<boolean> {
  const { getBoolSettingStrictResolved } = await import("@/services/settings");
  return getBoolSettingStrictResolved("cgo_autopilot_enabled", tenant_id);
}

const OFF: AutopilotState = { enabled: false, on_at: null };

export async function readChannelAutorunView(tenant_id: string, where = "view"): Promise<ChannelAutorunView> {
  const first = await readAutopilotState(tenant_id);
  const rows = await readAutorunRows(tenant_id);
  const autopilot = first.enabled && !(await stillOn(tenant_id)) ? OFF : first;
  const view = buildAutorunView(autopilot, rows);
  if (autopilot.enabled) for (const slug of view.rows.keys()) noteAutorunDrift(tenant_id, slug, view.resolve(slug), where);
  return view;
}

export async function readEffectiveAutorun(tenant_id: string, slug: string, where = "door"): Promise<boolean> {
  const autopilot = await readAutopilotState(tenant_id);
  if (!autopilot.enabled) return false;
  const row = await readAutorunRow(tenant_id, slug);
  if (!(await stillOn(tenant_id))) return false;
  const r = resolveChannelAutorun(autopilot, slug, row);
  noteAutorunDrift(tenant_id, slug, r, where);
  return r.effective;
}
