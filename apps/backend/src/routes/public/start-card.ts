
import { resetLeaderboardCache } from "@/services/start-card/leaderboard";
import type { Request, Response } from "express";
import { z } from "zod";
import type {
  StartCardConfigResponse,
  StartCardCreateResponse,
  StartCardQueueResponse,
} from "@zavi/shared";
import { getBoolSetting } from "@/services/settings";
import { verifyTurnstile, turnstileSiteKey } from "@/services/launch-video-public/captcha";
import { webBaseUrl } from "@/services/web-base";
import { sendStartCardConfirmEmail, sendStartCardRemoveEmail } from "@/email/sendAuthEmail";
import { emailCanRemove } from "@/services/start-card/report";
import { checkSiteReachable, normalizeEmail, normalizeSiteInput } from "@/services/start-card/request";
import { admitSite } from "@/services/start-card/admission";
import { asVisitorCountry } from "@/services/start-card/checks/country";
import { reserveCardBudget } from "@/services/start-card/budget";
import { createAndStartCard, retentionCutoffIso } from "@/services/start-card/queue";
import { inngest } from "@/../workers/client";
import {
  PUBLIC_ID_RE,
  confirmQueueRow,
  deleteRemovalToken,
  findRemovalToken,
  deleteQueueRow,
  deleteReportRow,
  getCardById,
  insertRemovalRequest,
  insertStaffReport,
  revokeCard,
  findPendingQueueRow,
  findRecentCardForDomain,
  generateConfirmToken,
  getPublicCardByPublicId,
  hashIp,
  hashToken,
  insertQueueRow,
  tickIpBucket,
  toPublicCard,
} from "@/services/start-card/store";

import { CARDS_PER_IP_PER_DAY, QUEUE_REQUESTS_PER_IP_PER_DAY, REPORTS_PER_IP_PER_DAY } from "@/services/start-card/limits";
export { CARDS_PER_IP_PER_DAY, QUEUE_REQUESTS_PER_IP_PER_DAY, REPORTS_PER_IP_PER_DAY } from "@/services/start-card/limits";
const DAY_SECONDS = 24 * 60 * 60;
const DEDUPE_WINDOW_MS = DAY_SECONDS * 1000;

const CreateBody = z.object({
  url: z.string().max(2048),
  turnstile_token: z.string().max(4096).nullish(),
  ref: z.string().max(64).nullish(),
  visitor_country: z.string().max(8).nullish(),
});

const ReportBody = z.object({
  public_id: z.string().max(64),
  email: z.string().max(320),
  reason: z.string().max(1000),
  turnstile_token: z.string().max(4096).nullish(),
});

const QueueBody = z.object({
  url: z.string().max(2048),
  email: z.string().max(320),
  turnstile_token: z.string().max(4096).nullish(),
});

type Fail = { status: number; code: string; message: string };

function send(res: Response, f: Fail): void {
  res.status(f.status).json({ error: { code: f.code, message: f.message } });
}

const NOT_FOUND: Fail = { status: 404, code: "not_found", message: "Not found." };
const SERVER_ERROR: Fail = { status: 500, code: "server_error", message: "Something went wrong. Please try again." };

function clientIp(req: Request): string | null {
  return req.ip || req.socket?.remoteAddress || null;
}

async function captchaGate(token: string | null | undefined, ip: string | null): Promise<Fail | null> {
  if (!(await getBoolSetting("start_card_captcha_required"))) return null;
  const verdict = turnstileSiteKey()
    ? await verifyTurnstile({ token: token ?? null, ip })
    : ({ ok: false, reason: "misconfigured" } as const);
  if (verdict.ok) return null;
  const ours = verdict.reason === "misconfigured" || verdict.reason === "unavailable";
  return ours
    ? { status: 503, code: "captcha_unavailable", message: "We can't verify your request right now. Please try again in a moment." }
    : { status: 400, code: "captcha_failed", message: "Please complete the verification and try again." };
}

const URL_MESSAGES: Record<string, string> = {
  missing_url: "Paste your website to get started.",
  url_too_long: "That address is too long.",
  invalid_url: "That doesn't look like a website address. Try something like yourcompany.com.",
  unsupported_scheme: "That doesn't look like a website address. Try something like yourcompany.com.",
  unsafe_url: "We can't check that address. Paste your public website.",
  unreachable: "We couldn't find that website. Check the address and try again.",
};

function urlFail(code: string): Fail {
  return { status: 400, code, message: URL_MESSAGES[code] ?? URL_MESSAGES.invalid_url };
}

async function ipGate(bucket: string, ip: string | null, limit: number): Promise<Fail | null> {
  if (!ip) {
    console.error(`[start-card] no client IP for ${bucket}, refusing`);
    return SERVER_ERROR;
  }
  try {
    const ok = await tickIpBucket(`${bucket}:${hashIp(ip)}`, limit, DAY_SECONDS);
    return ok
      ? null
      : { status: 429, code: "rate_limited", message: "You've checked a lot of sites today. Please try again tomorrow." };
  } catch (e) {
    console.error(`[start-card] rate-limit ledger failed, refusing: ${(e as Error).message}`);
    return SERVER_ERROR;
  }
}

export async function startCardCreate(req: Request, res: Response): Promise<void> {
  if (!(await getBoolSetting("start_card_enabled"))) return send(res, NOT_FOUND);

  const body = CreateBody.safeParse(req.body ?? {});
  if (!body.success) return send(res, urlFail("invalid_url"));

  const ip = clientIp(req);
  const admitted = await admitSite<Fail>(body.data.url, () => captchaGate(body.data.turnstile_token, ip));
  if (!admitted.ok) return send(res, "stopped" in admitted ? admitted.stopped : urlFail(admitted.code));
  const site = { value: admitted.site };

  try {
    const since = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString();
    const recent = await findRecentCardForDomain(site.value.domain, since);
    if (recent) {
      const out: StartCardCreateResponse = { state: "created", public_id: recent.public_id, reused: true };
      res.status(200).json(out);
      return;
    }
  } catch (e) {
    console.error(`[start-card] dedupe read failed: ${(e as Error).message?.slice(0, 200)}`);
    return send(res, SERVER_ERROR);
  }

  const limited = await ipGate("start_card", ip, CARDS_PER_IP_PER_DAY);
  if (limited) return send(res, limited);

  try {
    const reservation = await reserveCardBudget();
    if (!reservation.ok) {
      if (reservation.reason === "error") {
        return send(res, { status: 503, code: "budget_unavailable", message: "We can't start a card right now. Please try again in a minute." });
      }
      const out: StartCardCreateResponse = { state: "queued" };
      res.status(200).json(out);
      return;
    }

    let referrerCardId: string | null = null;
    if (body.data.ref && PUBLIC_ID_RE.test(body.data.ref)) {
      referrerCardId = (await getPublicCardByPublicId(body.data.ref).catch(() => null))?.id ?? null;
    }

    const card = await createAndStartCard(
      {
        domain: site.value.domain,
        ip_hash: ip ? hashIp(ip) : null,
        referrer_card_id: referrerCardId,
        visitor_country: asVisitorCountry(body.data.visitor_country),
      },
      reservation,
    );
    const out: StartCardCreateResponse = { state: "created", public_id: card.public_id, reused: card.reused };
    res.status(200).json(out);
  } catch (e) {
    console.error(`[start-card] create failed: ${(e as Error).message?.slice(0, 200)}`);
    send(res, SERVER_ERROR);
  }
}

export async function startCardConfig(_req: Request, res: Response): Promise<void> {
  if (!(await getBoolSetting("start_card_enabled"))) return send(res, NOT_FOUND);
  const required = await getBoolSetting("start_card_captcha_required");
  const out: StartCardConfigResponse = { captcha: { required, site_key: required ? turnstileSiteKey() : null } };
  res.json(out);
}

export async function startCardGet(req: Request, res: Response): Promise<void> {
  const publicId = String(req.params.public_id ?? "");
  if (!PUBLIC_ID_RE.test(publicId)) return send(res, NOT_FOUND);
  try {
    const row = await getPublicCardByPublicId(publicId);
    if (!row) return send(res, NOT_FOUND);
    const card = toPublicCard(row);
    res.setHeader("Cache-Control", card.status === "running" ? "no-store" : "public, max-age=60");
    res.json(card);
  } catch (e) {
    console.error(`[start-card] read failed: ${(e as Error).message?.slice(0, 200)}`);
    send(res, SERVER_ERROR);
  }
}

function apiBaseUrl(): string {
  return (process.env.BACKEND_PUBLIC_URL || "http://localhost:3001").replace(/\/+$/, "");
}

export async function startCardQueue(req: Request, res: Response): Promise<void> {
  if (!(await getBoolSetting("start_card_enabled"))) return send(res, NOT_FOUND);

  const body = QueueBody.safeParse(req.body ?? {});
  if (!body.success) return send(res, urlFail("invalid_url"));
  const site = normalizeSiteInput(body.data.url);
  if (!site.ok) return send(res, urlFail(site.error));
  const email = normalizeEmail(body.data.email);
  if (!email) return send(res, { status: 400, code: "invalid_email", message: "That email address doesn't look right." });

  const ip = clientIp(req);
  const captcha = await captchaGate(body.data.turnstile_token, ip);
  if (captcha) return send(res, captcha);

  const unreachable = await checkSiteReachable(site.value);
  if (unreachable) return send(res, urlFail(unreachable));

  const limited = await ipGate("start_card_queue", ip, QUEUE_REQUESTS_PER_IP_PER_DAY);
  if (limited) return send(res, limited);

  const ok: StartCardQueueResponse = { state: "confirm_sent" };
  try {
    if (await findPendingQueueRow(email, site.value.domain)) {
      res.status(200).json(ok);
      return;
    }
    const token = generateConfirmToken();
    const queueId = await insertQueueRow({
      email,
      domain: site.value.domain,
      confirm_token_hash: hashToken(token),
      ip_hash: ip ? hashIp(ip) : null,
    });
    const confirmUrl = `${apiBaseUrl()}/api/public/start-card/queue/confirm?token=${token}`;
    let sent = false;
    try {
      sent = (await sendStartCardConfirmEmail({ email, domain: site.value.domain, confirmUrl })).sent;
    } catch (e) {
      console.error(`[start-card] confirm email failed: ${(e as Error).message?.slice(0, 200)}`);
    }
    if (!sent) {
      await deleteQueueRow(queueId).catch(() => undefined);
      return send(res, { status: 503, code: "email_unavailable", message: "We couldn't send the email just now. Please try again later." });
    }
    res.status(200).json(ok);
  } catch (e) {
    console.error(`[start-card] queue failed: ${(e as Error).message?.slice(0, 200)}`);
    send(res, SERVER_ERROR);
  }
}

export async function startCardQueueConfirm(req: Request, res: Response): Promise<void> {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  const back = (outcome: string) => res.redirect(302, `${webBaseUrl()}/start?card_email=${outcome}`);
  if (!/^[a-f0-9]{64}$/.test(token)) return back("invalid");
  try {
    const row = await confirmQueueRow(hashToken(token), retentionCutoffIso());
    if (!row) return back("invalid");
    await inngest.send({ name: "start-card/queue.drain", data: {} }).catch((e: Error) => {
      console.warn(`[start-card] drain kick failed: ${e.message}`);
    });
    back("confirmed");
  } catch (e) {
    console.error(`[start-card] confirm failed: ${(e as Error).message?.slice(0, 200)}`);
    back("error");
  }
}

export async function startCardReport(req: Request, res: Response): Promise<void> {
  const body = ReportBody.safeParse(req.body ?? {});
  if (!body.success || !PUBLIC_ID_RE.test(body.data.public_id)) return send(res, NOT_FOUND);
  const email = normalizeEmail(body.data.email);
  if (!email) return send(res, { status: 400, code: "invalid_email", message: "That email address doesn't look right." });
  const reason = body.data.reason.trim();
  if (!reason) return send(res, { status: 400, code: "missing_reason", message: "Tell us what's wrong." });

  const ip = clientIp(req);
  const captcha = await captchaGate(body.data.turnstile_token, ip);
  if (captcha) return send(res, captcha);
  const limited = await ipGate("start_card_report", ip, REPORTS_PER_IP_PER_DAY);
  if (limited) return send(res, limited);

  try {
    const card = await getPublicCardByPublicId(body.data.public_id);
    if (!card) return send(res, NOT_FOUND);

    if (!emailCanRemove(email, card.domain)) {
      await insertStaffReport({ card_id: card.id, email, reason });
      console.warn(`[start-card] report received for card ${card.public_id}`);
      res.status(200).json({ state: "received" });
      return;
    }

    if (card.revoked_at) {
      res.status(200).json({ state: "verify_sent" });
      return;
    }
    const token = generateConfirmToken();
    const rowId = await insertRemovalRequest(card.id, hashToken(token));
    const removeUrl = `${apiBaseUrl()}/api/public/start-card/report/confirm?token=${token}`;
    let sent = false;
    try {
      sent = (await sendStartCardRemoveEmail({ email, domain: card.domain, removeUrl })).sent;
    } catch (e) {
      console.error(`[start-card] removal email failed: ${(e as Error).message?.slice(0, 200)}`);
    }
    if (!sent) {
      await deleteReportRow(rowId).catch(() => undefined);
      return send(res, { status: 503, code: "email_unavailable", message: "We couldn't send the email just now. Please try again later." });
    }
    res.status(200).json({ state: "verify_sent" });
  } catch (e) {
    console.error(`[start-card] report failed: ${(e as Error).message?.slice(0, 200)}`);
    send(res, SERVER_ERROR);
  }
}

const TOKEN_RE = /^[a-f0-9]{64}$/;

function confirmPage(token: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Remove this growth card</title></head>
<body style="font-family:system-ui,sans-serif;max-width:480px;margin:64px auto;padding:0 16px;color:#1f1f1f">
<h1 style="font-size:24px">Remove this growth card?</h1>
<p>This hides your site's Zavi growth card for everyone who has the link. It can't be undone.</p>
<form method="post" action="/api/public/start-card/report/confirm"><input type="hidden" name="token" value="${token}">
<button type="submit" style="min-height:48px;padding:0 20px;border:0;border-radius:12px;background:#027bff;color:#fff;font-size:15px;font-weight:600">Remove this result</button></form>
</body></html>`;
}

export async function startCardReportConfirmPage(req: Request, res: Response): Promise<void> {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  const back = (outcome: string) => res.redirect(302, `${webBaseUrl()}/start?card_remove=${outcome}`);
  if (!TOKEN_RE.test(token)) return back("invalid");
  try {
    if (!(await findRemovalToken(hashToken(token), retentionCutoffIso()))) return back("invalid");
    res.status(200).type("html").set("Cache-Control", "no-store").send(confirmPage(token));
  } catch (e) {
    console.error(`[start-card] removal page failed: ${(e as Error).message?.slice(0, 200)}`);
    back("error");
  }
}

export async function startCardReportConfirm(req: Request, res: Response): Promise<void> {
  const raw = (req.body as { token?: unknown } | undefined)?.token;
  const token = typeof raw === "string" ? raw : "";
  const back = (outcome: string) => res.redirect(303, `${webBaseUrl()}/start?card_remove=${outcome}`);
  if (!TOKEN_RE.test(token)) return back("invalid");
  try {
    const tokenHash = hashToken(token);
    const cardId = await findRemovalToken(tokenHash, retentionCutoffIso());
    if (!cardId) return back("invalid");
    await revokeCard(cardId);
    resetLeaderboardCache();
    await deleteRemovalToken(tokenHash);
    const card = await getCardById(cardId);
    if (!card) return back("invalid");
    res.redirect(303, `${webBaseUrl()}/r/${card.public_id}`);
  } catch (e) {
    console.error(`[start-card] removal confirm failed: ${(e as Error).message?.slice(0, 200)}`);
    back("error");
  }
}
