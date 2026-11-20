
import type { Request, Response } from "express";
import { z } from "zod";
import { assertStaff } from "@/services/auth/staff-middleware";
import { writeStaffAudit } from "@/services/staff/audit";
import {
  getSiteBackendSettings,
  PLATFORM_DEFAULTS,
  SiteSettingsError,
  setSiteBackendSettings,
  type SetSettingsDeps,
} from "@/services/site-shards/site-settings";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const int = (min: number, max: number) => z.number().int().min(min).max(max).nullable().optional();

export const PutBody = z
  .object({
    max_records: int(0, 100_000_000),
    max_bytes: int(0, 1_099_511_627_776),
    max_writes_per_min: int(0, 1_000_000),
    recipient_creates_per_min: int(1, 30),
    turnstile_enabled: z.boolean().nullable().optional(),
    turnstile_site_key: z.string().regex(/^[0-9A-Za-z_-]{10,100}$/).nullable().optional(),
    turnstile_secret: z.string().min(10).max(200).optional(),
    clear_turnstile_secret: z.boolean().optional(),
  })
  .strict()
  .refine((b) => !(b.turnstile_secret && b.clear_turnstile_secret), { message: "set OR clear the secret, not both" });

export const CUSTOM_TURNSTILE_SUPPORTED = true;

let depsOverride: SetSettingsDeps | null = null;
export function _setSiteSettingsDeps(d: SetSettingsDeps | null): void {
  depsOverride = d;
}

async function deps(): Promise<SetSettingsDeps> {
  if (depsOverride) return depsOverride;
  const [{ shardRegistry }, { createShardMgmt }, { cloudflareKv }, hostRecord, { siteStore }] = await Promise.all([
    import("@/services/site-shards/registry"),
    import("@/services/site-shards/shard-mgmt"),
    import("@/services/site-shards/gateway-kv"),
    import("@/services/sites/host-record"),
    import("@/services/sites/store"),
  ]);
  const mgmt = createShardMgmt();
  return {
    registry: shardRegistry(),
    sql: { query: (ref, q) => mgmt.query(ref, q) },
    host: { kv: cloudflareKv(), bump: hostRecord.bumpHostVersion, get: (t, id) => siteStore().get(t, id), requestVerify: hostRecord.requestHostVerify },
  };
}

function siteIdOf(req: Request, res: Response): string | null {
  const id = typeof req.params.site_id === "string" ? req.params.site_id.toLowerCase() : "";
  if (!UUID_RE.test(id)) {
    res.status(400).json({ error: { code: "invalid_site_id", message: "site_id must be a uuid" } });
    return null;
  }
  return id;
}

function fail(res: Response, e: unknown): void {
  if (e instanceof SiteSettingsError) {
    const status = e.code === "not_found" ? 404 : e.code === "invalid" ? 400 : 503;
    res.status(status).json({ error: { code: e.code, message: e.message } });
    return;
  }
  res.status(500).json({ error: { code: "site_settings_failed", message: String((e as Error)?.message ?? e).slice(0, 300) } });
}

export async function staffSiteBackendSettingsGet(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const site_id = siteIdOf(req, res);
  if (!site_id) return;
  try {
    res.json({ site_id, settings: await getSiteBackendSettings(site_id), defaults: PLATFORM_DEFAULTS });
  } catch (e) {
    fail(res, e);
  }
}

export async function staffSiteBackendSettingsPut(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const site_id = siteIdOf(req, res);
  if (!site_id) return;
  const parsed = PutBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { code: "invalid_body", message: parsed.error.message } });
    return;
  }
  if (!CUSTOM_TURNSTILE_SUPPORTED && (parsed.data.turnstile_secret || parsed.data.turnstile_site_key)) {
    res.status(400).json({
      error: { code: "custom_turnstile_unsupported", message: "A site-specific Turnstile widget is not supported yet; use turnstile_enabled (the platform widget) instead." },
    });
    return;
  }
  if (!!parsed.data.turnstile_site_key !== !!parsed.data.turnstile_secret) {
    res.status(400).json({ error: { code: "turnstile_pair_required", message: "A custom Turnstile widget needs both turnstile_site_key and turnstile_secret." } });
    return;
  }
  const { turnstile_secret, clear_turnstile_secret, ...patch } = parsed.data;
  try {
    const out = await setSiteBackendSettings(await deps(), {
      site_id,
      actor: { user_id: staff.user_id, email: staff.email },
      patch,
      turnstile_secret: turnstile_secret ?? null,
      clear_turnstile_secret: clear_turnstile_secret === true,
    });
    await writeStaffAudit({
      actor_user_id: staff.user_id,
      actor_email: staff.email,
      action: "site_backend_settings.set",
      target_table: "site_backend_settings",
      target_id: site_id,
      tenant_id: out.settings.tenant_id,
      meta: { patch, turnstile_secret: turnstile_secret ? "set" : clear_turnstile_secret ? "cleared" : "unchanged" },
    });
    res.json({ site_id, settings: out.settings, shard: out.shard, host_version: out.host_version, defaults: PLATFORM_DEFAULTS });
  } catch (e) {
    fail(res, e);
  }
}

type GraduationApi = {
  request(site_id: string): Promise<{ tenant_id: string; state: string } | null>;
  status(site_id: string): Promise<unknown>;
  kick(tenant_id: string, site_id: string): void;
};
let graduationOverride: GraduationApi | null = null;
export function _setGraduationApi(g: GraduationApi | null): void {
  graduationOverride = g;
}
async function graduationApi(): Promise<GraduationApi> {
  if (graduationOverride) return graduationOverride;
  const [{ createGraduationStore, kickGraduation }, { graduationDeps }] = await Promise.all([
    import("@/services/site-shards/graduation"),
    import("@/services/site-shards/facade"),
  ]);
  const store = createGraduationStore();
  return {
    request: (site_id) => store.requestBySite(site_id, "staff"),
    status: (site_id) => store.status(site_id),
    kick: (tenant_id, site_id) => kickGraduation(graduationDeps(), { tenant_id, site_id }),
  };
}

export async function staffSiteGraduate(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const site_id = siteIdOf(req, res);
  if (!site_id) return;
  try {
    const g = await graduationApi();
    const row = await g.request(site_id);
    if (!row) {
      res.status(409).json({ error: { code: "not_pooled", message: "only a site on the shared database can graduate" } });
      return;
    }
    await writeStaffAudit({
      actor_user_id: staff.user_id,
      actor_email: staff.email,
      action: "site_graduation.request",
      target_table: "site_graduations",
      target_id: site_id,
      tenant_id: row.tenant_id,
      meta: { state: row.state },
    });
    g.kick(row.tenant_id, site_id);
    res.status(202).json({ site_id, graduation: row });
  } catch (e) {
    fail(res, e);
  }
}

export async function staffSiteGraduation(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const site_id = siteIdOf(req, res);
  if (!site_id) return;
  try {
    res.json({ site_id, graduation: await (await graduationApi()).status(site_id) });
  } catch (e) {
    fail(res, e);
  }
}
