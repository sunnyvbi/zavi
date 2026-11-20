import type { Request, Response } from "express";
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { readLiveRun, readLiveRuns, type LiveStuntConfig } from "@/services/live-stunt/config";
import { toPublicPayload, type StoredDay } from "@/services/live-stunt/public-view";
import type { StuntSnapshot } from "@/services/live-stunt/snapshot";
import { DAY_KINDS, type DayKind } from "@/services/live-stunt/draft";
import { findIdentifiers, scrubPublicText } from "@/services/live-stunt/scrub";
import { hashToken, tokenValid } from "@/services/live-stunt/token";
import { demoPayload, demoReview, liveStuntDemoOn } from "@/services/live-stunt/demo-fixture";

const CACHE_MS = 5 * 60 * 1000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_COLS = "day, status, full_entry, neutral_entry, edited_headline, edited_why, edited_kind, published_at, updated_at";

type Inputs = { key: string; at: number; snapshot: StuntSnapshot | null; days: StoredDay[] };
const cache = new Map<string, Inputs>();
const keyOf = (cfg: LiveStuntConfig) => `${cfg.tenant_id}:${cfg.slug}`;

export function __resetLiveUpcarCache(): void {
  cache.clear();
}

const isMissingRelation = (e: { code?: string } | null) => !!e && (e.code === "42P01" || e.code === "PGRST205");

async function loadInputs(cfg: LiveStuntConfig): Promise<Inputs | "missing"> {
  const db = tenantClient(asTenantId(cfg.tenant_id));
  const [s, d] = await Promise.all([
    db.from("live_stunt_snapshots").select("payload, taken_at").eq("run_slug", cfg.slug).order("taken_at", { ascending: false }).limit(1),
    db.from("live_stunt_days").select(DAY_COLS).eq("run_slug", cfg.slug).eq("status", "published"),
  ]);
  if (isMissingRelation(s.error) || isMissingRelation(d.error)) return "missing";
  if (s.error || d.error) throw new Error("live_stunt_read_failed");
  const snapRow = ((s.data ?? []) as { payload: StuntSnapshot }[])[0];
  return { key: keyOf(cfg), at: Date.now(), snapshot: snapRow?.payload ?? null, days: (d.data ?? []) as StoredDay[] };
}

export async function publicLivePill(_req: Request, res: Response): Promise<void> {
  if (liveStuntDemoOn()) {
    res.set("Cache-Control", "no-store").json({ pill: { slug: "upcar" } });
    return;
  }
  const run = (await readLiveRuns()).find((r) => r.public && r.home_pill);
  res.set("Cache-Control", "public, max-age=60").json({ pill: run ? { slug: run.slug, ended: Date.now() >= Date.parse(run.end_at) } : null });
}

const slugOf = (req: Request) => String(req.params.slug ?? "");

export async function publicLiveUpcar(req: Request, res: Response): Promise<void> {
  if (liveStuntDemoOn() && ["upcar", "upcar-test"].includes(slugOf(req))) {
    res.set("Cache-Control", "no-store").json(demoPayload(slugOf(req), req.query.locked === "1"));
    return;
  }
  const cfg = await readLiveRun(slugOf(req));
  if (!cfg || !cfg.public) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const now = new Date();
  const hit = cache.get(keyOf(cfg));
  let inputs: Inputs | null = hit && Date.now() - hit.at < CACHE_MS ? hit : null;
  if (!inputs) {
    try {
      const loaded = await loadInputs(cfg);
      inputs = loaded === "missing" ? { key: keyOf(cfg), at: Date.now(), snapshot: null, days: [] } : loaded;
      cache.set(keyOf(cfg), inputs);
    } catch {
      if (hit) inputs = hit;
      else {
        res.status(503).json({ error: "unavailable" });
        return;
      }
    }
  }
  res.set("Cache-Control", "no-store").json(toPublicPayload({ snapshot: inputs.snapshot, days: inputs.days, cfg, now }));
}

function reviewHeaders(res: Response) {
  res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex", "Referrer-Policy": "no-referrer" });
}

export async function getLiveUpcarReview(req: Request, res: Response): Promise<void> {
  reviewHeaders(res);
  const day = String(req.params.day ?? "");
  const t = typeof req.query.t === "string" ? req.query.t : "";
  if (liveStuntDemoOn() && t === "demo") {
    res.json(demoReview());
    return;
  }
  const cfg = await readLiveRun(slugOf(req));
  if (!cfg || !DAY_RE.test(day) || !t) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const { data, error } = await tenantClient(asTenantId(cfg.tenant_id))
    .from("live_stunt_days")
    .select(`${DAY_COLS}, token_hash, token_expires_at`)
    .eq("run_slug", cfg.slug)
    .eq("day", day)
    .maybeSingle();
  const row = data as (StoredDay & { token_hash: string | null; token_expires_at: string }) | null;
  if (error || !row || row.status !== "draft" || !tokenValid({ presented: t, storedHash: row.token_hash, expiresAt: row.token_expires_at, now: new Date() })) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({
    day: row.day, status: row.status, full: row.full_entry, neutral: row.neutral_entry,
    edited_headline: row.edited_headline, edited_why: row.edited_why, edited_kind: row.edited_kind, expires_at: row.token_expires_at,
  });
}

export async function postLiveUpcarReview(req: Request, res: Response): Promise<void> {
  reviewHeaders(res);
  const day = String(req.params.day ?? "");
  const body = (req.body ?? {}) as Record<string, unknown>;
  const t = typeof body.t === "string" ? body.t : "";
  const action = body.action;
  if (action !== "publish" && action !== "hide") {
    res.status(400).json({ error: "bad_action" });
    return;
  }
  const kind = body.kind == null || body.kind === "" ? null : String(body.kind);
  if (kind !== null && !(DAY_KINDS as readonly string[]).includes(kind)) {
    res.status(400).json({ error: "bad_kind" });
    return;
  }
  const demo = liveStuntDemoOn() && t === "demo";
  const cfg = demo ? null : await readLiveRun(slugOf(req));
  if (!demo && (!cfg || !DAY_RE.test(day) || !t)) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  let campaignNames: string[] = [];
  if (cfg) {
    const { data: camps, error: campErr } = await tenantClient(asTenantId(cfg.tenant_id)).from("ad_campaigns").select("name");
    if (campErr) {
      res.status(503).json({ error: "unavailable" });
      return;
    }
    campaignNames = ((camps ?? []) as { name: string | null }[]).map((c) => c.name ?? "").filter(Boolean);
  }
  const clean = (v: unknown, max: number) => {
    if (typeof v !== "string" || !v.trim()) return null;
    return scrubPublicText(v.trim().slice(0, max + 100), { campaignNames }).slice(0, max) || null;
  };
  const headline = clean(body.headline, 200);
  const why = clean(body.why, 600);
  const matches = [...findIdentifiers(headline ?? ""), ...findIdentifiers(why ?? "")];
  if (matches.length) {
    res.status(422).json({ error: "identifier_in_text", matches });
    return;
  }
  if (demo || !cfg) {
    res.json({ ok: true, demo: true });
    return;
  }
  const { data, error } = await tenantRpc(asTenantId(cfg.tenant_id), "live_stunt_review_apply", {
    p_tenant_id: cfg.tenant_id, p_run_slug: cfg.slug, p_day: day, p_token_hash: hashToken(t), p_action: action,
    p_headline: headline, p_why: why, p_kind: kind as DayKind | null,
  });
  if (error) {
    res.status(503).json({ error: "unavailable" });
    return;
  }
  if (data !== "ok") {
    res.status(404).json({ error: "not_found" });
    return;
  }
  cache.delete(keyOf(cfg));
  res.json({ ok: true });
}
