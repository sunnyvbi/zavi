import type { Request, Response } from "express";
import { z } from "zod";
import { walletAuth as adsAuth, walletError as adsError } from "./wallet-auth";
import { refillEligibility } from "@/services/ads-wallet/providers";
import { completeSetup, createSetup, CREATOR_CONSENT_VERSION, disableRefill, REFILL_PAUSED_MESSAGE, REFILL_PLAN_MESSAGE, listCards, orderStatus, payWithCard, readWallet, selectCard, startFunding } from "@/services/ads-wallet/wallet";
const walletPlatform = z.enum(["chatgpt", "linkedin"]);
export async function adsWallet(req: Request, res: Response) {
  const auth = await adsAuth(req, res, false, true); if (!auth) return;
  try {
    const wallet = await readWallet(auth.tenant_id);
    const eligible = await refillEligibility(auth.tenant_id);
    const lastError = eligible === "paused" && wallet.auto_refill_enabled ? REFILL_PAUSED_MESSAGE
      : eligible === "below_plan" && wallet.auto_refill_enabled ? REFILL_PLAN_MESSAGE
      : (wallet.last_error === REFILL_PAUSED_MESSAGE || wallet.last_error === REFILL_PLAN_MESSAGE) && eligible === "allowed" ? null : wallet.last_error;
    res.json({ ...wallet, last_error: lastError, funding_enabled: wallet.funding_enabled && eligible === "allowed" });
  } catch (e) { adsError(res, e); }
}
export async function adsFund(req: Request, res: Response) {
  const auth = await adsAuth(req, res, true); if (!auth) return;
  try {
    const body = z.object({ amount_cents: z.number().int().min(100).max(500000), mode: z.enum(["topup", "setup"]), consent: z.boolean().optional(), enable_refill: z.boolean().optional(), request_id: z.string().uuid(), platform: walletPlatform.optional() }).strict().refine(v => v.mode !== "setup" || (v.amount_cents >= 5000 && v.amount_cents <= 100000), "Auto-refill must be between $50 and $1,000.").parse(req.body);
    if (body.mode === "setup" && body.consent !== true) { res.status(400).json({ error: { code: "consent_required", message: "Authorize the saved card before continuing." } }); return; }
    res.json(await startFunding(auth.tenant_id, auth.user_id, body.amount_cents, body.mode, body.request_id, body.mode === "setup" && body.enable_refill !== false, ...(body.platform ? [body.platform] : [])));
  } catch (e) { adsError(res, e); }
}
export async function adsDisableRefill(req: Request, res: Response) {
  const auth = await adsAuth(req, res, true, true); if (!auth) return;
  try { await disableRefill(auth.tenant_id); res.json({ ok: true }); } catch (e) { adsError(res, e); }
}

const refillAmount = z.number().int().min(5000).max(100000);
const cardChoice = { amount_cents: refillAmount, enable_refill: z.boolean(), allow_creators: z.boolean(), consent: z.literal(true), consent_version: z.string() };
function consentCurrent(version: string, res: Response): boolean {
  if (version === CREATOR_CONSENT_VERSION) return true;
  res.status(409).json({ error: { code: "consent_outdated", message: "The authorization text changed. Reopen Add balance and review it again." } });
  return false;
}
export async function adsCards(req: Request, res: Response) {
  const auth = await adsAuth(req, res, true); if (!auth) return;
  try { res.json(await listCards(auth.tenant_id, walletPlatform.catch("chatgpt").parse(req.query?.platform))); } catch (e) { adsError(res, e); }
}
export async function adsCardSetup(req: Request, res: Response) {
  const auth = await adsAuth(req, res, true); if (!auth) return;
  try {
    const body = z.object({ request_id: z.string().uuid(), ...cardChoice }).strict().parse(req.body);
    if (!consentCurrent(body.consent_version, res)) return;
    res.json(await createSetup(auth.tenant_id, auth.user_id, body.request_id, { amount: body.amount_cents, enableRefill: body.enable_refill, allowCreators: body.allow_creators }));
  } catch (e) { adsError(res, e); }
}
export async function adsCardSetupComplete(req: Request, res: Response) {
  const auth = await adsAuth(req, res, true, true); if (!auth) return;
  try {
    const body = z.object({ setup_intent_id: z.string().regex(/^seti_[A-Za-z0-9]+$/) }).strict().parse(req.body);
    res.json(await completeSetup(auth.tenant_id, body.setup_intent_id));
  } catch (e) { adsError(res, e); }
}
export async function adsCardSelect(req: Request, res: Response) {
  const auth = await adsAuth(req, res, true); if (!auth) return;
  try {
    const body = z.object({ payment_method_id: z.string().regex(/^pm_[A-Za-z0-9]+$/), ...cardChoice }).strict().parse(req.body);
    if (!consentCurrent(body.consent_version, res)) return;
    res.json(await selectCard(auth.tenant_id, auth.user_id, body.payment_method_id, { amount: body.amount_cents, enableRefill: body.enable_refill, allowCreators: body.allow_creators }));
  } catch (e) { adsError(res, e); }
}
export async function adsCardPay(req: Request, res: Response) {
  const auth = await adsAuth(req, res, true); if (!auth) return;
  try {
    const body = z.object({ request_id: z.string().uuid(), amount_cents: z.number().int().min(100).max(500000), payment_method_id: z.string().regex(/^pm_[A-Za-z0-9]+$/) }).strict().parse(req.body);
    res.json(await payWithCard(auth.tenant_id, body.amount_cents, body.request_id, body.payment_method_id));
  } catch (e) { adsError(res, e); }
}
export async function adsOrderStatus(req: Request, res: Response) {
  const auth = await adsAuth(req, res, true, true); if (!auth) return;
  try {
    const orderId = z.string().uuid().parse(req.params.orderId);
    res.json(await orderStatus(auth.tenant_id, orderId));
  } catch (e) { adsError(res, e); }
}
