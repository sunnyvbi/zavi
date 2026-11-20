import { apiFetch } from "@/lib/api";

export type PasteRoute = "sendgrid" | "mailchimp" | "klaviyo" | "zavi_list";

export type PastedEmail = { subject: string; preview_text?: string; body: string };

export type PasteEmailInput = { route: PasteRoute; list_id: string; pasted: PastedEmail };

export type PastedEmailCard = {
  ok: true;
  card: { rail: "channel_actions" | "decisions"; id: string };
  link: string;
  route: PasteRoute;
  versions: number;
};

export class PasteEmailError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = 0,
    public readonly requiredTier: string | null = null,
  ) {
    super(message);
    this.name = "PasteEmailError";
  }
}

export async function pasteEmail(input: PasteEmailInput, requestId?: string): Promise<PastedEmailCard> {
  let res: Response;
  try {
    res = await apiFetch("/api/email-cards/paste", {
      method: "POST",
      body: JSON.stringify({ inputs: input }),
      idempotent: true,
      ...(requestId ? { headers: { "Idempotency-Key": requestId } } : {}),
    });
  } catch {
    throw new PasteEmailError("network", "We could not reach Zavi. Check Email campaigns before trying again.");
  }
  const body = (await res.json().catch(() => null)) as (Partial<PastedEmailCard> & { error?: { code?: string; message?: string; required_tier?: string } }) | null;
  if (!res.ok || !body?.ok || !body.card || typeof body.link !== "string") {
    throw new PasteEmailError(body?.error?.code ?? "error", body?.error?.message ?? "That did not work. Try again.", res.status, body?.error?.required_tier ?? null);
  }
  return { ok: true, card: body.card, link: body.link, route: body.route as PasteRoute, versions: typeof body.versions === "number" ? body.versions : 1 };
}
