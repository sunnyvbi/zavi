
import type { Request, Response } from "express";
import { z } from "zod";
import { GROWTH_LEADERBOARD_CATEGORIES, START_CARD_LOCALES, type GrowthLeaderboardCategory } from "@zavi/shared";
import { getBoolSetting } from "@/services/settings";
import { PUBLIC_ID_RE } from "@/services/start-card/store";
import { DEFAULT_LIMIT, MAX_LIMIT, getLeaderboard, getLeaderboardRank } from "@/services/start-card/leaderboard";

const CATEGORY_KEYS = new Set<string>(GROWTH_LEADERBOARD_CATEGORIES.map((c) => c.key));

const Query = z.object({
  category: z.custom<GrowthLeaderboardCategory>((v) => typeof v === "string" && CATEGORY_KEYS.has(v)).optional(),
  country: z.enum(START_CARD_LOCALES).optional(),
  q: z.string().max(100).optional(),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
});

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

const notFound = (res: Response) => fail(res, 404, "not_found", "Not found.");
const serverError = (res: Response) => fail(res, 500, "server_error", "Something went wrong. Please try again.");

function firstParams(q: Request["query"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(q ?? {})) {
    const s = Array.isArray(v) ? v[0] : v;
    if (typeof s === "string" && s !== "") out[k] = s;
  }
  return out;
}

export async function leaderboardList(req: Request, res: Response): Promise<void> {
  if (!(await getBoolSetting("growth_leaderboard_enabled"))) return notFound(res);
  const parsed = Query.safeParse(firstParams(req.query));
  if (!parsed.success) return fail(res, 400, "invalid_query", "That filter isn't valid.");
  const { category, country, q, offset, limit } = parsed.data;
  try {
    const out = await getLeaderboard({ category, country, q, offset, limit });
    res.setHeader("Cache-Control", "no-store");
    res.json(out);
  } catch (e) {
    console.error(`[leaderboard] list failed: ${(e as Error).message?.slice(0, 200)}`);
    serverError(res);
  }
}

export async function leaderboardRank(req: Request, res: Response): Promise<void> {
  if (!(await getBoolSetting("growth_leaderboard_enabled"))) return notFound(res);
  const publicId = String(req.params.public_id ?? "");
  if (!PUBLIC_ID_RE.test(publicId)) return notFound(res);
  try {
    const out = await getLeaderboardRank(publicId);
    res.setHeader("Cache-Control", "no-store");
    res.json(out);
  } catch (e) {
    console.error(`[leaderboard] rank failed: ${(e as Error).message?.slice(0, 200)}`);
    serverError(res);
  }
}
