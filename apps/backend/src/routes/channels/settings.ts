
import type { Request, Response } from "express";
import { z } from "zod";
import { isChannelSlug, isRetiredSetting, writesElsewhere } from "@zavi/shared";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { tenantClient, tenantRpc, type TenantId } from "@/services/tenant-client";
import {
  competitorNameKey,
  normalizeSubreddit,
  REDDIT_CHANNEL_SLUG,
  REDDIT_FIELDS,
} from "@/services/channels/reddit/workspace";
import { getCompanyFacts } from "@/services/company/facts";
import { connectedPinterestUsername } from "@/services/connectors/pinterest-composio/readiness";
import { BulkEmailError } from "@/services/comms/bulk-outbound/errors";
import { normalizeSendingDomain } from "@/services/comms/bulk-outbound/sending-domain";

const FIELD_ID = /^[a-z][a-z0-9_]{0,63}$/;

const SettingsItem = z.union([
  z.string().trim().min(1).max(300),
  z.object({
    item: z.string().trim().min(1).max(300),
    item_type: z.string().trim().min(1).max(40).nullish(),
    status: z.enum(["suggested", "tracking", "paused", "dismissed"]).nullish(),
    position: z.number().int().min(0).max(10_000).nullish(),
    note: z.string().trim().max(300).nullish(),
    origin: z.enum(["suggested", "custom"]).nullish(),
    detail: z.string().trim().min(1).max(200).nullish(),
  }),
]);

const MAX_ITEMS = 200;
const PutBody = z.object({ items: z.array(SettingsItem).max(MAX_ITEMS) });

type PutItem = z.infer<typeof SettingsItem>;

function normaliseRedditCommunities(
  slug: string,
  fieldId: string,
  items: PutItem[],
): { ok: true; items: PutItem[] } | { ok: false; item: string } {
  if (slug !== REDDIT_CHANNEL_SLUG || fieldId !== REDDIT_FIELDS.communities) return { ok: true, items };
  const seen = new Set<string>();
  const out: PutItem[] = [];
  for (const it of items) {
    const raw = typeof it === "string" ? it : it.item;
    const name = normalizeSubreddit(raw);
    if (!name) return { ok: false, item: raw };
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(typeof it === "string" ? name : { ...it, item: name });
  }
  return { ok: true, items: out };
}

function normaliseSendingDomainItems(
  slug: string,
  fieldId: string,
  items: PutItem[],
): { ok: true; items: PutItem[] } | { ok: false; refusal: BulkEmailError } {
  if (slug !== "email_marketing" || fieldId !== "sending_domain") return { ok: true, items };
  try {
    return {
      ok: true,
      items: items.map((it) =>
        typeof it === "string" ? normalizeSendingDomain(it) : { ...it, item: normalizeSendingDomain(it.item) },
      ),
    };
  } catch (e) {
    if (e instanceof BulkEmailError) return { ok: false, refusal: e };
    throw e;
  }
}

const HTTPS_URL_FIELDS = new Set(["linkedin_ads:landing_page"]);

function isHttpsUrl(value: string): boolean {
  try {
    const u = new URL(value.trim());
    return u.protocol === "https:" && u.hostname.includes(".");
  } catch {
    return false;
  }
}

function firstBadUrl(slug: string, fieldId: string, items: PutItem[]): string | null {
  if (!HTTPS_URL_FIELDS.has(`${slug}:${fieldId}`)) return null;
  for (const it of items) {
    const raw = typeof it === "string" ? it : it.item;
    if (!isHttpsUrl(raw)) return raw;
  }
  return null;
}

const NON_NEGATIVE_NUMBER_FIELDS = new Set(["linkedin_ads:deal_value"]);

function firstBadNumber(slug: string, fieldId: string, items: PutItem[]): string | null {
  if (!NON_NEGATIVE_NUMBER_FIELDS.has(`${slug}:${fieldId}`)) return null;
  for (const it of items) {
    const raw = typeof it === "string" ? it : it.item;
    const n = Number(raw.trim());
    if (!/^\d+(\.\d+)?$/.test(raw.trim()) || !Number.isFinite(n) || n < 0) return raw;
  }
  return null;
}

type RpcItem = {
  item: string;
  item_type: string | null;
  status: string | null;
  position: number | null;
  note: string | null;
  origin: string | null;
  detail: string | null;
};

const DISMISSED_POSITION = 10_000;

async function keepReseededAsDismissed(
  tenantId: TenantId,
  slug: string,
  fieldId: string,
  items: RpcItem[],
): Promise<RpcItem[]> {
  if (slug !== REDDIT_CHANNEL_SLUG) return [];
  if (fieldId !== REDDIT_FIELDS.competitors && fieldId !== REDDIT_FIELDS.keywords) return [];
  const { data, error } = await tenantRpc(tenantId, "get_channel_settings", { p_channel_slug: slug });
  if (error) {
    console.warn(`[channel-settings] reddit removal check ${fieldId}: ${error.message}`);
    return [];
  }
  const current = ((data as { fields?: Record<string, RpcItem[]> } | null)?.fields?.[fieldId] ?? []) as RpcItem[];
  const sent = new Set(items.map((i) => i.item.trim().toLowerCase()));
  const removed = current.filter((r) => !sent.has(r.item.trim().toLowerCase()));
  if (removed.length === 0) return [];

  let reseeded: (r: RpcItem) => boolean;
  if (fieldId === REDDIT_FIELDS.keywords) {
    reseeded = (r) => r.item_type === "brand";
  } else {
    const record = await getCompanyFacts(tenantId)
      .then((f) => new Set(f.competitors.map(competitorNameKey)))
      .catch(() => null);
    reseeded = (r) => record === null || record.has(competitorNameKey(r.item));
  }
  return removed
    .filter(reseeded)
    .map((r) => ({ ...r, status: "dismissed", position: DISMISSED_POSITION }));
}

function badSlug(res: Response): void {
  res.status(404).json({ error: { code: "unknown_channel", message: "Unknown channel." } });
}

const PREFILL: Record<string, Record<string, (tenantId: string) => Promise<string | null>>> = {
  pinterest_organic: { handle: connectedPinterestUsername },
};

export async function settingsPrefill(
  tenantId: string,
  slug: string,
  fields: Record<string, unknown>,
): Promise<Record<string, Array<{ item: string }>>> {
  const out: Record<string, Array<{ item: string }>> = {};
  for (const [id, read] of Object.entries(PREFILL[slug] ?? {})) {
    const current = fields[id];
    if (Array.isArray(current) && current.length > 0) continue;
    const value = await read(tenantId);
    if (value) out[id] = [{ item: value }];
  }
  return out;
}

async function connectedEmailTool(tenantId: string): Promise<string | null> {
  try {
    return await (await import("@/services/connectors/email-campaign/account")).soleEmailTool(tenantId);
  } catch (e) {
    console.warn(`[channel-settings] email tool read: ${(e as Error).message}`);
    return null;
  }
}

export async function channelSettingsGet(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const slug = String(req.params.slug ?? "");
  if (!isChannelSlug(slug)) return badSlug(res);

  try {
    const { data, error } = await tenantRpc(auth.tenant_id, "get_channel_settings", {
      p_channel_slug: slug,
    });
    if (error) {
      console.warn(`[channel-settings] read ${slug}: ${error.message}`);
      res.status(500).json({ error: { code: "read_failed", message: "Could not read settings." } });
      return;
    }
    const out = (data ?? {}) as { fields?: Record<string, unknown> };
    const fields = out.fields ?? {};
    if (fields.budget === undefined) {
      const usd = await monthlyBudgetOf(auth.tenant_id, slug);
      if (usd !== null) fields.budget = [{ item: String(usd) }];
    }
    const emailTool = slug === "email_marketing" ? await connectedEmailTool(auth.tenant_id) : null;
    res.json({ fields, prefill: await settingsPrefill(auth.tenant_id, slug, fields), ...(emailTool ? { email_tool: emailTool } : {}) });
  } catch (e) {
    console.warn(`[channel-settings] read ${slug}: ${(e as Error).message}`);
    res.status(500).json({ error: { code: "read_failed", message: "Could not read settings." } });
  }
}

async function monthlyBudgetOf(tenantId: TenantId, slug: string): Promise<number | null> {
  try {
    const { data, error } = await tenantClient(tenantId)
      .from("tenant_channels")
      .select("monthly_budget_usd")
      .eq("channel_slug", slug)
      .maybeSingle();
    if (error || !data) return null;
    const v = (data as { monthly_budget_usd?: number | string | null }).monthly_budget_usd;
    const n = v === null || v === undefined ? null : Number(v);
    return n !== null && Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export async function channelSettingsPut(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if ((auth as { tenant_overridden?: boolean }).tenant_overridden === true) {
    res.status(403).json({
      error: { code: "tenant_override_forbidden", message: "Not available for an overridden tenant." },
    });
    return;
  }

  const allowed = await requireTenantRole(auth, ["owner", "admin"], res);
  if (!allowed) return;

  const slug = String(req.params.slug ?? "");
  if (!isChannelSlug(slug)) return badSlug(res);

  const fieldId = String(req.params.fieldId ?? "").trim();
  if (!FIELD_ID.test(fieldId)) {
    res.status(400).json({ error: { code: "bad_field_id", message: "Unknown setting." } });
    return;
  }
  if (writesElsewhere(fieldId)) {
    res.status(409).json({
      error: {
        code: "field_writes_elsewhere",
        message: "That setting has its own store and is not saved here.",
      },
    });
    return;
  }
  if (slug === "email_marketing" && fieldId === "sending_domain") {
    const registered = await import("@/services/comms/bulk-outbound/sending-domain")
      .then((m) => m.getSendingDomain(auth.tenant_id))
      .then((d) => d !== null, () => null);
    if (registered === null) {
      res.status(500).json({ error: { code: "write_failed", message: "Those settings did not save." } });
      return;
    }
    if (registered) {
      res.status(409).json({
        error: {
          code: "field_writes_elsewhere",
          message: "Your sending domain is set under Settings > Sending domain, and this setting follows it.",
        },
      });
      return;
    }
  }
  if (isRetiredSetting(slug, fieldId)) {
    res.status(409).json({
      error: {
        code: "field_retired",
        message: "This channel no longer offers that setting.",
      },
    });
    return;
  }

  const body = PutBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: { code: "validation", message: z.prettifyError(body.error) } });
    return;
  }
  if (
    slug === "email_marketing" &&
    (fieldId === "sendgrid_sender_id" || fieldId === "sendgrid_suppression_group_id") &&
    (body.data.items.length !== 1 || typeof body.data.items[0] !== "string")
  ) {
    res.status(400).json({
      error: {
        code: "required_setting",
        message: fieldId === "sendgrid_sender_id" ? "Pick a verified SendGrid sender." : "Pick a SendGrid unsubscribe group.",
      },
    });
    return;
  }

  const domains = normaliseSendingDomainItems(slug, fieldId, body.data.items);
  if (!domains.ok) {
    res.status(domains.refusal.status).json({
      error: { code: domains.refusal.code, message: domains.refusal.message },
    });
    return;
  }

  const normalised = normaliseRedditCommunities(slug, fieldId, domains.items);
  if (!normalised.ok) {
    res.status(400).json({
      error: {
        code: "invalid_subreddit",
        message: `"${normalised.item}" is not a subreddit name. Use a name like r/smallbusiness. Nothing was saved.`,
      },
    });
    return;
  }

  const badUrl = firstBadUrl(slug, fieldId, normalised.items);
  if (badUrl !== null) {
    res.status(400).json({
      error: {
        code: "invalid_url",
        message: /^http:\/\//i.test(badUrl.trim())
          ? `"${badUrl}" starts with http://. Zavi opens landing pages only over a secure link, so use the https:// address, like https://example.com/demo. Nothing was saved.`
          : `"${badUrl}" is not a web address. Use a full link like https://example.com/demo. Nothing was saved.`,
      },
    });
    return;
  }

  const badNumber = firstBadNumber(slug, fieldId, normalised.items);
  if (badNumber !== null) {
    res.status(400).json({
      error: {
        code: "invalid_number",
        message: `"${badNumber}" is not an amount. Use a number of zero or more, like 12000. Nothing was saved.`,
      },
    });
    return;
  }

  const items = normalised.items.map((it, i) =>
    typeof it === "string"
      ? { item: it, item_type: null, status: null, position: i, note: null, origin: null, detail: null }
      : {
          item: it.item,
          item_type: it.item_type ?? null,
          status: it.status ?? null,
          position: it.position ?? i,
          note: it.note ?? null,
          origin: it.origin ?? null,
          detail: it.detail ?? null,
        },
  );

  try {
    const kept = await keepReseededAsDismissed(auth.tenant_id, slug, fieldId, items);
    if (items.length + kept.length > MAX_ITEMS) {
      res.status(400).json({
        error: {
          code: "too_many_items",
          message: `This list holds at most ${MAX_ITEMS} entries, including the ones you removed that Zavi keeps as dismissed. Remove a few more, then save. Nothing was saved.`,
        },
      });
      return;
    }
    const { data, error } = await tenantRpc(auth.tenant_id, "set_channel_settings", {
      p_channel_slug: slug,
      p_field_id: fieldId,
      p_items: [...items, ...kept],
      p_actor_user_id: auth.user_id,
    });
    if (error) {
      console.warn(`[channel-settings] write ${slug}/${fieldId}: ${error.message}`);
      res.status(500).json({ error: { code: "write_failed", message: "Those settings did not save." } });
      return;
    }
    const out = (data ?? {}) as {
      ok?: boolean;
      code?: string;
      value?: string;
      item?: string;
      written?: number;
      deleted?: number;
      dropped?: number;
      fields?: Record<string, unknown>;
    };
    if (!out.ok) {
      const vocab = out.code === "invalid_status" || out.code === "invalid_origin";
      const message = vocab
        ? `${out.code === "invalid_status" ? "Status" : "Origin"} ${JSON.stringify(out.value ?? "")} is not one we store${out.item ? ` (on "${out.item}")` : ""}. Nothing was saved.`
        : "Those settings can't be saved from here.";
      res.status(out.code === "unknown_channel" ? 404 : 400).json({
        error: { code: out.code ?? "refused", message },
      });
      return;
    }
    res.json({
      field_id: fieldId,
      written: out.written ?? 0,
      deleted: out.deleted ?? 0,
      dropped: out.dropped ?? 0,
      fields: out.fields ?? {},
    });
  } catch (e) {
    console.warn(`[channel-settings] write ${slug}/${fieldId}: ${(e as Error).message}`);
    res.status(500).json({ error: { code: "write_failed", message: "Those settings did not save." } });
  }
}
