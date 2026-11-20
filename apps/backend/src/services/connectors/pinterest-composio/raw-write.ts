import { composioToolIsRead } from "@/services/connectors/composio/write-classify";

export const PINTEREST_TOOLKIT = "pinterest";

export function isRawPinterestWrite(slug: string, toolkit?: string | null): boolean {
  const s = slug.trim().toUpperCase();
  if (!s.startsWith("PINTEREST_") && toolkit?.toLowerCase() !== PINTEREST_TOOLKIT) return false;
  return !composioToolIsRead(s, PINTEREST_TOOLKIT, undefined);
}

export const PINTEREST_RAW_WRITE_MESSAGE =
  "Pins are posted only through social__propose_post with channel pinterest_pin, which checks the board, image and link and waits for the founder's approval. Nothing was sent and nothing was proposed.";
