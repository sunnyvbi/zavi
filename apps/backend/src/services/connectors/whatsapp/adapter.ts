
export type WhatsAppEnv = {
  accessToken: string;
  phoneNumberId: string;
  appSecret: string;
  verifyToken: string;
  businessNumber: string;
  graphVersion: string;
  windowTemplate: string;
};

const DEFAULT_GRAPH_VERSION = "v26.0";
const DEFAULT_WINDOW_TEMPLATE = "zavi_answer_ready_v1";

export function whatsappEnabled(): boolean {
  return Boolean(
    process.env.WHATSAPP_ACCESS_TOKEN &&
      process.env.WHATSAPP_PHONE_NUMBER_ID &&
      process.env.WHATSAPP_APP_SECRET &&
      process.env.WHATSAPP_VERIFY_TOKEN,
  );
}

export function whatsappOwnsNumber(phoneNumberId: string): boolean {
  const env = whatsappEnv();
  return !!env && !!phoneNumberId && env.phoneNumberId === phoneNumberId;
}

export function whatsappEnv(): WhatsAppEnv | null {
  if (!whatsappEnabled()) return null;
  return {
    accessToken: String(process.env.WHATSAPP_ACCESS_TOKEN),
    phoneNumberId: String(process.env.WHATSAPP_PHONE_NUMBER_ID),
    appSecret: String(process.env.WHATSAPP_APP_SECRET),
    verifyToken: String(process.env.WHATSAPP_VERIFY_TOKEN),
    businessNumber: String(process.env.WHATSAPP_BUSINESS_NUMBER ?? "").replace(/[^\d]/g, ""),
    graphVersion: String(process.env.WHATSAPP_GRAPH_VERSION || DEFAULT_GRAPH_VERSION),
    windowTemplate: String(process.env.WHATSAPP_WINDOW_TEMPLATE || DEFAULT_WINDOW_TEMPLATE),
  };
}

export type WhatsAppCallResult = {
  ok: boolean;
  status: number;
  errorCode?: number;
  errorMessage?: string;
  messageId?: string;
};

export async function callWhatsApp(
  to: string,
  payload: Record<string, unknown>,
): Promise<WhatsAppCallResult> {
  const env = whatsappEnv();
  if (!env) return { ok: false, status: 0, errorMessage: "whatsapp_disabled" };

  const url = `https://graph.facebook.com/${env.graphVersion}/${env.phoneNumberId}/messages`;
  const body = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    ...payload,
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as {
      messages?: { id?: string }[];
      error?: { code?: number; message?: string };
    };
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        errorCode: typeof json?.error?.code === "number" ? json.error.code : undefined,
        errorMessage: typeof json?.error?.message === "string" ? json.error.message : undefined,
      };
    }
    return { ok: true, status: res.status, messageId: json?.messages?.[0]?.id };
  } catch (e) {
    return { ok: false, status: 0, errorMessage: (e as Error).message };
  }
}

export const WINDOW_CLOSED_ERROR_CODES = new Set([131047, 131026]);

export const RECIPIENT_GONE_ERROR_CODES = new Set([131052, 131051]);
