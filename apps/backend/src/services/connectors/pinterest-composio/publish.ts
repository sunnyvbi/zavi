import { composioExecuteTool, type ComposioExecResult, type OwnedComposioAccount } from "@/services/connectors/composio/api";
import { composioFailure, composioReceipt } from "@/services/connectors/composio/publish-receipt";
import { SOCIAL_LIMITS } from "@zavi/shared";

const TITLE_MAX = 100;
const DESCRIPTION_MAX = SOCIAL_LIMITS.pinterest_pin.text;
const ALT_MAX = 500;
export const CREATE_PIN_TIMEOUT_MS = 30_000;

export type PinterestPin = {
  board_id: string;
  title: string;
  description: string;
  link: string;
  alt_text?: string;
};

export async function publishPinterestPinViaComposio(
  account: OwnedComposioAccount,
  pin: PinterestPin,
  imageUrl: string,
  timeoutMs: number = CREATE_PIN_TIMEOUT_MS,
): Promise<{ ok: boolean; status: number; raw: Record<string, unknown> }> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<ComposioExecResult>((resolve) => {
    timer = setTimeout(() => {
      ctrl.abort();
      resolve({ ok: false, status: 0, data: null, error: "composio_timeout", outcome_unknown: true });
    }, timeoutMs);
  });
  const call = composioExecuteTool({
    tool_slug: "PINTEREST_CREATE_PIN",
    user_id: account.tenant_id,
    connected_account_id: account.connected_account_id,
    arguments: {
      board_id: pin.board_id,
      title: pin.title.slice(0, TITLE_MAX),
      description: pin.description.slice(0, DESCRIPTION_MAX),
      link: pin.link,
      ...(pin.alt_text ? { alt_text: pin.alt_text.slice(0, ALT_MAX) } : {}),
      media_source: { source_type: "image_url", url: imageUrl },
    },
  }, ctrl.signal);
  const r = await Promise.race([call, timedOut]).finally(() => clearTimeout(timer));
  if (!r.ok) return composioFailure(r, "pin create failed");
  const { id, response: d } = composioReceipt(r.data);
  if (!id) {
    return { ok: false, status: 0, raw: { error: "Pinterest returned no pin id; check the board before staging this pin again", response: d } };
  }
  return { ok: true, status: 200, raw: { id, url: `https://www.pinterest.com/pin/${id}/` } };
}
