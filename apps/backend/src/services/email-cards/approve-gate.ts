
export const EMAIL_CARD_CLASSES: ReadonlySet<string> = new Set([
  "email_campaign.create_and_send",
  "bulk_outbound.send",
]);

export const EMAIL_CARD_APPROVE_REQUIRED = "email_card_approve_required";

export const EMAIL_CARD_APPROVE_MESSAGE =
  "Open this email in Zavi to pick a version, send yourself a test, and approve it there.";

export function isEmailCardClass(cls: string | null | undefined): boolean {
  return typeof cls === "string" && EMAIL_CARD_CLASSES.has(cls);
}
