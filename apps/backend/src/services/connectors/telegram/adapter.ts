
import crypto from "node:crypto";

export type TelegramEnv = {
  botToken: string;
  webhookSecret: string;
  botUsername: string;
};

export function telegramEnabled(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_WEBHOOK_SECRET);
}

export function telegramEnv(): TelegramEnv | null {
  if (!telegramEnabled()) return null;
  return {
    botToken: String(process.env.TELEGRAM_BOT_TOKEN),
    webhookSecret: String(process.env.TELEGRAM_WEBHOOK_SECRET),
    botUsername: String(process.env.TELEGRAM_BOT_USERNAME ?? "").replace(/^@/, ""),
  };
}

export function verifyWebhookSecret(headerValue: unknown): boolean {
  const env = telegramEnv();
  if (!env) return false;
  const got = typeof headerValue === "string" ? headerValue : "";
  if (!got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(env.webhookSecret);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export type TelegramCallResult =
  | { ok: true; result: unknown }
  | { ok: false; disabled?: boolean; status?: number; error: string };

export async function callTelegram(
  method: string,
  params: Record<string, unknown>,
): Promise<TelegramCallResult> {
  const env = telegramEnv();
  if (!env) return { ok: false, disabled: true, error: "telegram_disabled" };
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; result?: unknown; description?: string }
      | null;
    if (!res.ok || !body?.ok) {
      return {
        ok: false,
        status: res.status,
        error: String(body?.description ?? `telegram_http_${res.status}`),
      };
    }
    return { ok: true, result: body.result };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
