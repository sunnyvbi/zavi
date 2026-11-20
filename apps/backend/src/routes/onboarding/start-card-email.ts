import type { Request, Response } from "express";
import { z } from "zod";
import { verifyBearer } from "@/services/auth/jwt";
import { getBoolSetting } from "@/services/settings";
import { inngest } from "@/../workers/client";
import { checkSiteReachable, normalizeEmail, normalizeSiteInput } from "@/services/start-card/request";
import { getPublicCardByPublicId, hashIp, hashToken, insertAccountQueueRow, isTenantFunded, tickIpBucket } from "@/services/start-card/store";
import { QUEUE_REQUESTS_PER_ACCOUNT_PER_DAY, QUEUE_REQUESTS_PER_IP_PER_DAY, START_CARD_RATE_WINDOW_SECONDS } from "@/services/start-card/limits";

const Body = z
  .object({ public_id: z.string().min(1).max(64).optional(), url: z.string().min(1).max(2048).optional() })
  .refine((b) => !!b.public_id || !!b.url);

export type StartCardEmailState = "queued" | "unavailable";

function admitAccount(userId: string): Promise<boolean> {
  return tickIpBucket(
    `start_card_account_queue:${hashToken(userId)}`,
    QUEUE_REQUESTS_PER_ACCOUNT_PER_DAY,
    START_CARD_RATE_WINDOW_SECONDS,
  );
}

async function admitAccountQueue(req: Request, userId: string): Promise<boolean> {
  const ip = req.ip || req.socket?.remoteAddress;
  if (!ip) throw new Error("Missing client IP");
  return (await admitAccount(userId)) && tickIpBucket(
    `start_card_queue:${hashIp(ip)}`,
    QUEUE_REQUESTS_PER_IP_PER_DAY,
    START_CARD_RATE_WINDOW_SECONDS,
  );
}

function kickEmailQueue(): void {
  void inngest.send({ name: "start-card/queue.drain", data: {} }).catch((e: Error) => {
    console.warn(`[start-card] drain kick failed: ${e.message}`);
  });
}

export async function onboardingStartCardEmail(req: Request, res: Response): Promise<void> {
  const verified = await verifyBearer(req);
  if (!verified) {
    res.status(401).json({ error: { code: "unauthenticated", message: "Missing or invalid Bearer token." } });
    return;
  }
  const body = Body.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: { code: "invalid_body", message: "public_id or url is required." } });
    return;
  }
  const email = normalizeEmail(verified.email);
  if (!email) {
    res.status(400).json({ error: { code: "no_email", message: "This account has no email address." } });
    return;
  }
  const answer = (state: StartCardEmailState) => res.status(200).json({ state });
  const rateLimited = () =>
    res.status(429).json({ error: { code: "rate_limited", message: "You've requested a lot of cards today. Please try again tomorrow." } });
  try {
    if (!(await getBoolSetting("start_card_enabled"))) return void answer("unavailable");
    if (!body.data.public_id) {
      const site = normalizeSiteInput(body.data.url);
      if (!site.ok) return void answer("unavailable");
      if (!(await admitAccountQueue(req, verified.user_id))) return void rateLimited();
      if (await checkSiteReachable(site.value)) return void answer("unavailable");
      await insertAccountQueueRow({ email, domain: site.value.domain, card_id: null });
      kickEmailQueue();
      return void answer("queued");
    }
    const card = await getPublicCardByPublicId(body.data.public_id);
    if (!card || isTenantFunded(card) || card.revoked_at) return void answer("unavailable");
    if (card.status !== "running" && card.status !== "done") return void answer("unavailable");
    if (!(await admitAccount(verified.user_id))) return void rateLimited();

    await insertAccountQueueRow({ email, domain: card.domain, card_id: card.id });
    kickEmailQueue();
    answer("queued");
  } catch (e) {
    console.error(`[start-card] onboarding email failed: ${(e as Error).message?.slice(0, 200)}`);
    res.status(500).json({ error: { code: "server_error", message: "Could not queue the card email." } });
  }
}
