import { SOCIAL_LIMITS } from "@zavi/shared";
import { validateChannelPayload, IMAGE_PATH_RE } from "@/services/connectors/social-channels";

export type SocialDraftEdit = { text?: string; thread?: string[] | null; image_path?: string; title?: string; board_id?: string; link?: string };
export const PIN_FIELD_EDITS = ["title", "board_id", "link"] as const;

function applyPinEdit(channel: string, payload: Record<string, unknown>, edit: SocialDraftEdit) {
  if (!PIN_FIELD_EDITS.some((k) => edit[k] !== undefined)) return;
  if (channel !== "pinterest_pin") throw new Error("Only a pin's title, board and link can be edited here.");
  if (edit.title !== undefined) {
    const title = edit.title.trim();
    if (!title || title.length > SOCIAL_LIMITS.pinterest_pin.title) throw new Error(`The pin title must be 1 to ${SOCIAL_LIMITS.pinterest_pin.title} characters.`);
    payload.title = title;
  }
  if (edit.board_id !== undefined) {
    if (!/^\d{1,30}$/.test(edit.board_id)) throw new Error("Pick one of your Pinterest boards.");
    if (edit.board_id !== payload.board_id) delete payload.board_name;
    payload.board_id = edit.board_id;
  }
  if (edit.link !== undefined) {
    const link = edit.link.trim();
    let ok = false;
    try {
      ok = new URL(link).protocol === "https:" && link.startsWith("https://") && link.length <= 2048;
    } catch {
      ok = false;
    }
    if (!ok) throw new Error("The pin link must be a full web address that starts with https://.");
    payload.link = link;
  }
}

export function editedSocialDraft(tenantId: string, body: Record<string, unknown>, edit: SocialDraftEdit) {
  let channel = typeof body.channel === "string" ? body.channel : "";
  const prior = body.payload;
  const payload: Record<string, unknown> = prior && typeof prior === "object" && !Array.isArray(prior) ? Object.fromEntries(Object.entries(prior)) : {};
  if (edit.text !== undefined) payload.text = edit.text;
  if (edit.thread === null) delete payload.thread;
  else if (edit.thread !== undefined) payload.thread = edit.thread;
  if (edit.image_path !== undefined) {
    if (!edit.image_path.startsWith(`${tenantId}/`) || !IMAGE_PATH_RE.test(edit.image_path)) throw new Error("Choose an image from this workspace.");
    payload.image_path = edit.image_path;
    if (channel === "x") channel = "x_image";
    if (channel === "linkedin") channel = "linkedin_image";
  }
  applyPinEdit(channel, payload, edit);
  return { channel, payload: validateChannelPayload(channel, payload) };
}

const PIN_CHECK_LABELS: Array<[string, string]> = [
  ["board", "Board"],
  ["media", "Image"],
  ["link", "Link"],
  ["identity", "Your site"],
];

export function unverifiedPinChecks(readiness: unknown): string[] {
  const checks = readiness && typeof readiness === "object" ? (readiness as { checks?: unknown }).checks : null;
  if (!checks || typeof checks !== "object") return [];
  return PIN_CHECK_LABELS.flatMap(([key, label]) => {
    const c = (checks as Record<string, { status?: unknown; reason?: unknown } | undefined>)[key];
    if (c?.status !== "unverified") return [];
    return [`${label}: ${typeof c.reason === "string" && c.reason ? c.reason : "Zavi could not check this."}`];
  });
}

export async function recheckEditedPin(
  tenantId: string,
  prior: unknown,
  next: Record<string, unknown>,
): Promise<
  | { ok: true; readiness: unknown; board_name: string }
  | { ok: true; readiness?: undefined; board_name?: undefined }
  | { ok: false; reason: string }
> {
  const before = prior && typeof prior === "object" ? (prior as Record<string, unknown>) : {};
  if (["board_id", "link", "image_path"].every((k) => before[k] === next[k])) return { ok: true };
  const { resolvePinterestPublishReadiness } = await import("@/services/connectors/pinterest-composio/readiness");
  const readiness = await resolvePinterestPublishReadiness(tenantId, {
    board_id: String(next.board_id),
    image_path: String(next.image_path),
    link: String(next.link),
  });
  if (!readiness.ok || !readiness.board) {
    return { ok: false, reason: readiness.reason ?? "Zavi could not confirm the Pinterest board." };
  }
  return { ok: true, readiness, board_name: readiness.board.name };
}
