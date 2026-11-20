
import { aliasKeyFromEnv } from "./index";
import {
  drainFormNotifications,
  formNotifyUnsubscribeUrl,
  type DrainTally,
  type FormNotifyDeps,
  type FormNotifyTarget,
} from "./form-notify";
import type { SiteAuthDirectory } from "./types";

export type FormNotifyRunResult =
  | { skipped: "not_canonical" | "not_configured" }
  | { shards: number; unmigrated: number; shard_failed: number } & DrainTally;

const isUnmigrated = (e: unknown) => {
  const err = e as { code?: unknown; message?: unknown };
  return err?.code === "42883" || (/form_notify_/.test(String(err?.message ?? "")) && /does not exist/.test(String(err?.message ?? "")));
};

export async function readFormNotifyTarget(siteId: string): Promise<FormNotifyTarget | null> {
  const { sitePublicRpc } = await import("@/services/tenant-client");
  const { data, error } = await sitePublicRpc("site_form_notify_target", { p_site_id: siteId });
  if (error) throw new Error(`site_form_notify_target failed${error.code ? ` (${error.code})` : ""}`);
  const r = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
  if (!r || typeof r.tenant_id !== "string") return null;
  return {
    tenantId: r.tenant_id,
    ownerEmail: typeof r.owner_email === "string" ? r.owner_email : null,
    hostname: String(r.hostname ?? ""),
    name: typeof r.label === "string" ? r.label : null,
    status: String(r.status ?? ""),
    muted: r.muted === true,
    version: Number.isSafeInteger(Number(r.version)) ? Number(r.version) : 0,
  };
}

export async function resolveFormNotifyRecipient(t: FormNotifyTarget): Promise<string | null> {
  if (t.ownerEmail) return t.ownerEmail;
  const { resolveTenantOwnerEmail } = await import("@/email/sendAuthEmail");
  return resolveTenantOwnerEmail(t.tenantId);
}

export async function runFormNotifyDrain(env: NodeJS.ProcessEnv = process.env): Promise<FormNotifyRunResult> {
  if (env.PRAXIS_CONTAINER_ROLE !== "canonical") return { skipped: "not_canonical" };
  let key: string;
  try {
    key = aliasKeyFromEnv();
  } catch {
    return { skipped: "not_configured" };
  }
  const [{ createDefaultDirectory }, { shardEnv, shardRegistry }, mail, { createSiteNoticeMailer }] = await Promise.all([
    import("./directory"),
    import("@/services/site-shards/registry"),
    import("@/email/sendAuthEmail"),
    import("./mailer"),
  ]);
  const directory: SiteAuthDirectory = (directoryCache ??= createDefaultDirectory());
  const deps: FormNotifyDeps = {
    directory,
    target: readFormNotifyTarget,
    tenantOwnerEmail: (t) => mail.resolveTenantOwnerEmail(t),
    alert: async (msg, code) => (await import("@/services/logging/alert")).alert({ msg, source: "site-form-notify", code }),
    mailer: createSiteNoticeMailer(),
    unsubscribeUrl: (siteId, recipient, version) =>
      formNotifyUnsubscribeUrl(env.BACKEND_PUBLIC_URL, key, { siteId, recipient, version, nowS: Date.now() / 1000 }),
    log: (l) => console.warn(l),
  };
  const shards = (await shardRegistry().list(shardEnv())).filter(
    (s) => typeof s.project_ref === "string" && s.state !== "retired" && s.state !== "provisioning",
  );
  const out = { shards: shards.length, unmigrated: 0, shard_failed: 0, sent: 0, records: 0, dropped: 0, deferred: 0, failed: 0, lost: 0, rounds: 0 };
  for (const s of shards) {
    try {
      const handle = await directory.shard(s.project_ref as string);
      if (!handle) {
        out.shard_failed++;
        continue;
      }
      const t = await drainFormNotifications(deps, handle);
      out.sent += t.sent;
      out.records += t.records;
      out.dropped += t.dropped;
      out.deferred += t.deferred;
      out.failed += t.failed;
      out.lost += t.lost;
      out.rounds += t.rounds;
    } catch (e) {
      if (isUnmigrated(e)) {
        out.unmigrated++;
        continue;
      }
      out.shard_failed++;
      console.warn(`[site-form-notify] ${JSON.stringify({ event: "shard_failed", shard: s.name, error: String((e as Error)?.message ?? e).slice(0, 160) })}`);
    }
  }
  return out;
}

let directoryCache: SiteAuthDirectory | null = null;
