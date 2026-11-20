import { createHash } from "node:crypto";

export const WEB_ONLY_APPROVE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "stripe.create_payment": [
    "amount",
    "currency",
    "application_fee_amount",
    "client_reference",
    "description",
    "receipt_email",
  ],
  "stripe.remit_to_tenant": [
    "client_reference",
    "description",
    "held_fund_id",
    "currency",
    "gross_minor",
    "reserve_minor",
    "fee_minor",
    "net_minor",
  ],
  "extension.money_step": [
    "host",
    "label",
    "op",
    "op_args",
    "value",
    "frame_url",
    "frame_session",
    "backend_node_id",
    "screenshot_id",
    "run_owner_user_id",
    "held_op_id",
  ],
};

export function isWebOnlyApproveClass(cls: string | null | undefined): boolean {
  return !!cls && Object.prototype.hasOwnProperty.call(WEB_ONLY_APPROVE_FIELDS, cls);
}

export function moneyCardFingerprint(cls: string, body: Record<string, unknown>): string | null {
  const fields = WEB_ONLY_APPROVE_FIELDS[cls];
  if (!fields) return null;
  const sealed: Record<string, unknown> = { decision_class: cls };
  for (const k of fields) sealed[k] = body[k] ?? null;
  return createHash("sha256").update(JSON.stringify(sealed)).digest("hex");
}

export function moneyCardSealIntact(cls: string, body: Record<string, unknown> | null | undefined): boolean {
  if (!body || typeof body.fingerprint !== "string") return false;
  return body.fingerprint === moneyCardFingerprint(cls, body);
}
