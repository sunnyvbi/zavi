
import { API_BASE } from "../shared/config";

export type ConsentState = {
  granted: boolean;
  version: string | null;
  granted_at: string | null;
  revoked_at: string | null;
  current_version: string;
};

export type ConsentReply = {
  consent: ConsentState;
  consent_required: boolean;
  current_version?: string;
  runs_cleared?: number;
};

export const CONSENT_REQUIRED_CODE = "consent_required";

async function call(token: string, method: "GET" | "POST" | "DELETE"): Promise<ConsentReply> {
  const res = await fetch(`${API_BASE}/api/extension/consent`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
  }
  if (!res.ok) {
    const err = (body as { error?: { message?: string } } | null)?.error;
    throw new Error(err?.message ?? `Consent request failed (${res.status}).`);
  }
  return body as ConsentReply;
}

export async function getConsent(token: string): Promise<ConsentReply> {
  return call(token, "GET");
}

export async function grantConsent(token: string): Promise<ConsentReply> {
  return call(token, "POST");
}

export async function revokeConsent(token: string): Promise<ConsentReply> {
  return call(token, "DELETE");
}
