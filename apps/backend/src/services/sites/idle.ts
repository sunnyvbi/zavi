
import { resolveTenantOwnerEmail, sgSend } from "@/email/sendAuthEmail";
import { renderEmail } from "@/email/theme";
import { consumeTenantRateLimit, asTenantId } from "@/services/tenant-client";
import { tickAttemptBucket } from "@/services/launch-video-public/store";
import { staticHostingConfig } from "@/services/hosting/static-publish";
import { getBoolSetting } from "@/services/settings";
import { SupabaseMgmtError } from "./supabase-mgmt";
import {
  SITE_IDLE_PAUSE_DAYS,
  SiteCredentialsMissing,
  siteKv,
  type SitePublicResolver,
  type SiteRow,
  type SiteStore,
  type SupabaseSiteProvisioner,
} from "./contract";
import { siteStore } from "./store";
import { sitePublicResolver } from "./public-resolver";
import { supabaseSiteProvisioner } from "./supabase-site-provisioner";

const DAY_MS = 24 * 60 * 60 * 1000;
export const IDLE_BATCH_SIZE = 50;
export const IDLE_MAX_BATCHES = 200;
export const WAKE_STALE_MS = 15 * 60 * 1000;
export const WAKE_WINDOW_SECONDS = 60 * 60;
export const DEFAULT_WAKE_GLOBAL_PER_HOUR = 60;
export const DEFAULT_WAKE_SITE_PER_HOUR = 4;
export const WAKE_GLOBAL_BUCKET = "site_wake:global";

export type SiteKvClient = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
};

export type IdleDeps = {
  store: SiteStore;
  resolver: SitePublicResolver;
  provisioner: Pick<SupabaseSiteProvisioner, "pause" | "restore">;
  kv: SiteKvClient;
  ownerEmail: (tenant_id: string) => Promise<string | null>;
  sendEmail: (to: string, subject: string, html: string, text: string) => Promise<void>;
  tickGlobal: (key: string, limit: number, windowSeconds: number) => Promise<boolean>;
  tickSite: (tenant_id: string, site_id: string, limit: number, windowSeconds: number) => Promise<boolean>;
  now: () => number;
  pauseEnabled?: () => Promise<boolean>;
  wakeGlobalPerHour?: number;
  wakeSitePerHour?: number;
  log?: (msg: string) => void;
};

type KvFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; text(): Promise<string> }>;

export function createSiteKv(opts: { env?: Record<string, string | undefined>; fetchFn?: KvFetch } = {}): SiteKvClient {
  const cfg = staticHostingConfig(opts.env ?? process.env);
  if (!cfg.ok) throw new SiteCredentialsMissing(cfg.missing);
  const fetchFn: KvFetch = opts.fetchFn ?? ((u, i) => fetch(u, i as RequestInit) as unknown as ReturnType<KvFetch>);
  const url = (key: string) =>
    `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/storage/kv/namespaces/${cfg.kvNamespaceId}/values/${encodeURIComponent(key)}`;
  const auth = { Authorization: `Bearer ${cfg.token}` };
  const ok = (s: number) => s >= 200 && s < 300;
  return {
    async get(key) {
      const res = await fetchFn(url(key), { method: "GET", headers: auth });
      if (res.status === 404) return null;
      if (!ok(res.status)) throw new Error(`kv read failed (${res.status})`);
      return await res.text();
    },
    async put(key, value) {
      const res = await fetchFn(url(key), { method: "PUT", headers: { ...auth, "Content-Type": "text/plain" }, body: value });
      if (!ok(res.status)) throw new Error(`kv write failed (${res.status})`);
    },
    async delete(key) {
      const res = await fetchFn(url(key), { method: "DELETE", headers: auth });
      if (!ok(res.status) && res.status !== 404) throw new Error(`kv delete failed (${res.status})`);
    },
  };
}

export function defaultIdleDeps(): IdleDeps {
  let kv: SiteKvClient | null = null;
  const lazyKv = (): SiteKvClient => (kv ??= createSiteKv());
  const intEnv = (k: string, d: number) => {
    const n = Number(process.env[k]);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
  };
  return {
    store: siteStore(),
    resolver: sitePublicResolver(),
    provisioner: supabaseSiteProvisioner(),
    kv: {
      get: (k) => lazyKv().get(k),
      put: (k, v) => lazyKv().put(k, v),
      delete: (k) => lazyKv().delete(k),
    },
    ownerEmail: (t) => resolveTenantOwnerEmail(t),
    sendEmail: (to, subject, html, text) => sgSend(to, subject, html, text),
    tickGlobal: (key, limit, windowSeconds) => tickAttemptBucket(key, limit, windowSeconds),
    tickSite: (t, s, limit, windowSeconds) => consumeTenantRateLimit(asTenantId(t), `site_wake:${s}`, limit, windowSeconds),
    now: () => Date.now(),
    pauseEnabled: () => getBoolSetting("site_idle_pause_enabled"),
    wakeGlobalPerHour: intEnv("SITE_WAKE_GLOBAL_PER_HOUR", DEFAULT_WAKE_GLOBAL_PER_HOUR),
    wakeSitePerHour: intEnv("SITE_WAKE_SITE_PER_HOUR", DEFAULT_WAKE_SITE_PER_HOUR),
    log: (m) => console.warn(m),
  };
}

const ts = (iso: string | null | undefined): number => {
  const n = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(n) ? n : NaN;
};

export function parseLastSeen(raw: string | null): number | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  if (/^\d+$/.test(v)) {
    const n = Number(v);
    return n < 1e12 ? n * 1000 : n;
  }
  const p = Date.parse(v);
  return Number.isFinite(p) ? p : null;
}

export function isIdle(site: Pick<SiteRow, "last_visit_at" | "last_edit_at" | "created_at">, cutoffMs: number): boolean {
  const created = ts(site.created_at);
  const visit = ts(site.last_visit_at);
  const edit = ts(site.last_edit_at);
  const v = Number.isFinite(visit) ? visit : created;
  const e = Number.isFinite(edit) ? edit : created;
  return Number.isFinite(v) && Number.isFinite(e) && v < cutoffMs && e < cutoffMs;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function renderPausedEmail(hostname: string): { subject: string; html: string; text: string } {
  const subject = `${hostname} is paused`;
  const text =
    `${hostname} is paused because nobody visited or edited it for ${SITE_IDLE_PAUSE_DAYS} days.\n\n` +
    `Nothing is lost. It wakes on its next visit, which takes about 2 minutes.`;
  const h = escapeHtml(hostname);
  const html = renderEmail({
    preheader: "Nothing is lost. It wakes on its next visit.",
    kicker: "Your site",
    eyebrow: "Paused",
    title: "Your site is paused",
    intro: `<strong>${h}</strong> is paused because nobody visited or edited it for ${SITE_IDLE_PAUSE_DAYS} days.`,
    details: [
      { label: "Your data", value: "Safe. Nothing is lost." },
      { label: "To wake it", value: "Open the site. It takes about 2 minutes." },
    ],
    body: "",
    ctaText: "Wake my site",
    ctaUrl: `https://${h}`,
    footerNote: "You get this email because you own this site on Zavi.",
    footerVariant: "neutral",
  });
  return { subject, html, text };
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export type SweepResult = {
  considered: number;
  paused: number;
  visited: number;
  skipped: number;
  failed: number;
  refused: number;
  stopped?: "disabled" | "pause_unsupported";
};

function definitelyRefused(e: unknown): boolean {
  return e instanceof SupabaseMgmtError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429;
}

export async function sweepIdleSites(deps: IdleDeps): Promise<SweepResult> {
  const log = deps.log ?? (() => {});
  const nowMs = deps.now();
  const cutoffMs = nowMs - SITE_IDLE_PAUSE_DAYS * DAY_MS;
  const cutoffIso = new Date(cutoffMs).toISOString();
  const seen = new Set<string>();
  const out: SweepResult = { considered: 0, paused: 0, visited: 0, skipped: 0, failed: 0, refused: 0 };
  if (deps.pauseEnabled && !(await deps.pauseEnabled())) return { ...out, stopped: "disabled" };

  sweep: for (let batchNo = 0; batchNo < IDLE_MAX_BATCHES; batchNo++) {
    const batch = await deps.resolver.claimIdleBatch(cutoffIso, IDLE_BATCH_SIZE);
    const fresh = batch.filter((c) => !seen.has(c.site_id));
    if (!fresh.length) break;

    for (const c of fresh) {
      seen.add(c.site_id);
      out.considered += 1;
      try {
        const site0 = await deps.store.get(c.tenant_id, c.site_id);
        if (!site0) { out.skipped += 1; continue; }
        const seenAt = parseLastSeen(await deps.kv.get(siteKv.lastSeen(site0.hostname)));
        let site = site0;
        if (seenAt != null && !(seenAt <= ts(site0.last_visit_at))) {
          site = await deps.store.update(c.tenant_id, c.site_id, { last_visit_at: new Date(seenAt).toISOString() });
        }
        if (site.status !== "live" || !isIdle(site, cutoffMs)) {
          if (seenAt != null && seenAt >= cutoffMs) out.visited += 1;
          else out.skipped += 1;
          continue;
        }
        if (!site.supabase_project_ref) { out.skipped += 1; continue; }
        const claimed = await deps.store.transition(c.tenant_id, c.site_id, ["live"], "paused", {
          paused_at: new Date(nowMs).toISOString(),
        });
        if (!claimed) { out.skipped += 1; continue; }
        const pausedKey = siteKv.paused(claimed.hostname);

        try {
          await deps.kv.put(pausedKey, "1");
        } catch (e) {
          await unclaim(deps, c.tenant_id, c.site_id, pausedKey, `pause flag failed: ${errText(e)}`);
          out.failed += 1;
          log(`[sites] idle pause flag failed for site ${c.site_id}: ${errText(e)}`);
          continue;
        }
        let outcome: "paused" | "unsupported" | "no_project" | "refused";
        try {
          outcome = await deps.provisioner.pause({ tenant_id: c.tenant_id, site_id: c.site_id });
        } catch (e) {
          if (!definitelyRefused(e)) {
            await deps.store.update(c.tenant_id, c.site_id, { last_error: `pause uncertain: ${errText(e)}` }).catch(() => null);
            out.failed += 1;
            log(`[sites] idle pause uncertain for site ${c.site_id}: ${errText(e)}`);
            continue;
          }
          outcome = "refused";
        }
        if (outcome !== "paused") {
          await unclaim(deps, c.tenant_id, c.site_id, pausedKey, `idle pause not applied: ${outcome}`);
          out.refused += 1;
          log(`[sites] idle pause not applied for site ${c.site_id} (${outcome}); site left live`);
          if (outcome === "unsupported") {
            out.stopped = "pause_unsupported";
            log("[sites] ALERT idle pause unsupported by the Supabase org's plan; sweep stopped. Turn off site_idle_pause_enabled.");
            break sweep;
          }
          continue;
        }
        out.paused += 1;

        try {
          const to = claimed.owner_email || (await deps.ownerEmail(c.tenant_id));
          if (to) {
            const m = renderPausedEmail(claimed.hostname);
            await deps.sendEmail(to, m.subject, m.html, m.text);
          }
        } catch (e) {
          log(`[sites] paused email failed for site ${c.site_id}: ${errText(e)}`);
        }
      } catch (e) {
        out.failed += 1;
        log(`[sites] idle sweep error for site ${c.site_id}: ${errText(e)}`);
      }
    }
  }
  return out;
}

async function unclaim(deps: IdleDeps, tenant_id: string, site_id: string, pausedKey: string, reason: string): Promise<void> {
  await deps.store.transition(tenant_id, site_id, ["paused"], "live", { paused_at: null, last_error: reason });
  await deps.kv.delete(pausedKey).catch((e) => (deps.log ?? (() => {}))(`[sites] kv clear failed: ${errText(e)}`));
}

export type WakeStatus = "unknown" | "live" | "waking" | "paused" | string;
export type WakeResult = { status: WakeStatus; done?: Promise<void> };

async function backToPaused(deps: IdleDeps, tenant_id: string, site_id: string, reason: string): Promise<void> {
  await deps.store.transition(tenant_id, site_id, ["waking"], "paused", { last_error: reason }).catch(() => null);
}

export async function wakeSite(hostname: string, deps: IdleDeps): Promise<WakeResult> {
  const log = deps.log ?? (() => {});
  const found = await deps.resolver.byHostname(hostname);
  if (!found) return { status: "unknown" };
  const { tenant_id, site_id } = found;

  if (found.status === "live") {
    const site = await deps.store.get(tenant_id, site_id);
    if (site) await deps.kv.delete(siteKv.paused(site.hostname)).catch(() => {});
    return { status: "live" };
  }

  if (found.status === "waking") {
    const site = await deps.store.get(tenant_id, site_id);
    const stale = site && deps.now() - ts(site.updated_at) > WAKE_STALE_MS;
    if (!stale) return { status: "waking" };
    const reset = await deps.store.transition(tenant_id, site_id, ["waking"], "paused", { last_error: "wake timed out" });
    if (!reset) return { status: "waking" };
  } else if (found.status !== "paused") {
    return { status: found.status };
  }

  const claimed = await deps.store.transition(tenant_id, site_id, ["paused"], "waking", {});
  if (!claimed) return { status: "waking" };

  let allowed = false;
  try {
    allowed =
      (await deps.tickGlobal(WAKE_GLOBAL_BUCKET, deps.wakeGlobalPerHour ?? DEFAULT_WAKE_GLOBAL_PER_HOUR, WAKE_WINDOW_SECONDS)) &&
      (await deps.tickSite(tenant_id, site_id, deps.wakeSitePerHour ?? DEFAULT_WAKE_SITE_PER_HOUR, WAKE_WINDOW_SECONDS));
  } catch (e) {
    log(`[sites] wake budget ledger failed: ${errText(e)}`);
    allowed = false;
  }
  if (!allowed) {
    await backToPaused(deps, tenant_id, site_id, "wake budget exhausted, try again later");
    return { status: "paused" };
  }

  const done = (async () => {
    try {
      await deps.provisioner.restore({ tenant_id, site_id });
      const live = await deps.store.transition(tenant_id, site_id, ["waking"], "live", {
        paused_at: null,
        last_error: null,
        last_visit_at: new Date(deps.now()).toISOString(),
      });
      if (live) await deps.kv.delete(siteKv.paused(live.hostname)).catch((e) => log(`[sites] kv clear failed: ${errText(e)}`));
    } catch (e) {
      log(`[sites] wake failed for site ${site_id}: ${errText(e)}`);
      await backToPaused(deps, tenant_id, site_id, `wake failed: ${errText(e)}`);
    }
  })();
  return { status: "waking", done };
}
