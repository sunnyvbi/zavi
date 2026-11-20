
export const APP_CHANGE_ROUTE = "app_edit";
export const BUILD_REFINE_CONFIRMATION = "On it. I'm applying that to this build; you can follow it above, and the preview updates when it's built.";
export const BUILD_ROUTE_UNAVAILABLE =
  "I couldn't safely connect that request to this build, so I didn't start a separate chat. Please try again.";

export type EditFailureBody = { code?: string; chat?: string; message?: string; request?: string };

export const NEEDS_SITE_CHANGE_CODE = "needs_site_change";
export const SITE_CHANGE_OFFER_FALLBACK =
  "That's more than a change to this element, so it needs a change to the site itself.";
export const SITE_CHANGE_STARTED = "Started. It shows in your preview when it's built.";
export const SITE_CHANGE_USE_CHAT = "Describe it in the chat and Zavi will make it.";

export class SiteChangeOffer extends Error {
  readonly request: string;
  constructor(message: string, request: string) {
    super(message);
    this.name = "SiteChangeOffer";
    this.request = request;
  }
}

export function siteChangeOfferFrom(err: EditFailureBody | undefined): SiteChangeOffer | null {
  if (err?.code !== NEEDS_SITE_CHANGE_CODE) return null;
  const request = typeof err.request === "string" ? err.request.trim() : "";
  if (!request) return null;
  const chat = typeof err.chat === "string" && err.chat.trim() ? err.chat.trim() : SITE_CHANGE_OFFER_FALLBACK;
  return new SiteChangeOffer(chat, request);
}

export type SiteChangeResult = { ok: true; held?: string } | { ok: false; message: string };

export function siteChangeFailureText(refusal: string | { headline: string; detail: string } | { kind: string; message: string }): string {
  if (typeof refusal === "string") return refusal;
  if ("headline" in refusal) return `${refusal.headline}${refusal.detail}`.trim();
  return refusal.message;
}

export function askAiFailureMessage(status: number, err?: EditFailureBody): string {
  const detail = err?.chat?.trim();
  if (detail) return detail;
  switch (status) {
    case 422:
      return "Couldn't turn that into a text, color, or link change. Say what to change, e.g. \"make the title shorter\".";
    case 403:
      return "This app isn't registered to your workspace, so it can't be edited here.";
    case 429:
      return "That's a lot of quick edits. Wait a moment, then try again.";
    case 401:
      return "Your session expired. Sign in again, then retry.";
    case 502:
      return "The AI didn't answer. Try again in a moment.";
    default:
      return `Something went wrong (${status}). Try again.`;
  }
}

export type BeforeSendResult = {
  handled: boolean;
  system?: string;
  consumed?: boolean;
  creditWall?: string;
};

export type ClassifyRejection = { rejected: string };

export type WebsiteChatEditDeps = {
  classify: (message: string) => Promise<string | undefined | ClassifyRejection>;
  refine?: (message: string) => Promise<{ ok: true; note?: string | null; held?: string } | { ok: false; message: string; credit?: boolean }>;
};

export async function resolveBuildRefine(
  message: string,
  refine: NonNullable<WebsiteChatEditDeps["refine"]>,
): Promise<BeforeSendResult> {
  const outcome = await refine(message);
  if (outcome.ok) {
    const note = outcome.note?.trim();
    const line = outcome.held?.trim() || BUILD_REFINE_CONFIRMATION;
    return { handled: true, consumed: true, system: note ? `${note} ${line}` : line };
  }
  return outcome.credit ? { handled: true, creditWall: outcome.message } : { handled: true, system: outcome.message };
}

export async function resolveWebsiteChatEdit(
  message: string,
  deps: WebsiteChatEditDeps,
): Promise<BeforeSendResult> {
  let outcome: string | undefined | ClassifyRejection;
  try {
    outcome = await deps.classify(message);
  } catch {
    return deps.refine
      ? { handled: true, system: BUILD_ROUTE_UNAVAILABLE }
      : { handled: false };
  }
  if (typeof outcome === "object") {
    return deps.refine ? { handled: true, system: outcome.rejected } : { handled: false };
  }
  const route = outcome;
  if (route === undefined && deps.refine) {
    return { handled: true, system: BUILD_ROUTE_UNAVAILABLE };
  }
  if (route === APP_CHANGE_ROUTE && deps.refine) {
    return resolveBuildRefine(message, deps.refine);
  }
  return { handled: false };
}
