
import { composioProxy, type OwnedComposioAccount } from "@/services/connectors/composio/api";

export type GoogleApiAuth =
  | { kind: "native"; access_token: string }
  | { kind: "composio"; account: OwnedComposioAccount };

export type GoogleApiResponse = { ok: boolean; status: number; json: Record<string, unknown> };

export async function googleApiRequest(
  auth: GoogleApiAuth,
  a: { method: "GET" | "POST"; url: string; body?: unknown; timeoutMs?: number },
): Promise<GoogleApiResponse> {
  if (auth.kind === "composio") {
    const proxied = composioProxy({
      account: auth.account,
      method: a.method,
      endpoint: a.url,
      ...(a.body !== undefined ? { body: a.body } : {}),
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const e = new Error(`Composio proxy did not respond within ${a.timeoutMs ?? 10_000}ms`);
        e.name = "TimeoutError";
        reject(e);
      }, a.timeoutMs ?? 10_000);
    });
    try {
      return await Promise.race([proxied, budget]);
    } finally {
      clearTimeout(timer);
    }
  }
  const r = await fetch(a.url, {
    method: a.method,
    headers: {
      Authorization: `Bearer ${auth.access_token}`,
      ...(a.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(a.body !== undefined ? { body: JSON.stringify(a.body) } : {}),
    signal: AbortSignal.timeout(a.timeoutMs ?? 10_000),
  });
  const json = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: r.ok, status: r.status, json };
}

export function googleApiErrorText(res: GoogleApiResponse): string {
  try {
    return JSON.stringify(res.json).slice(0, 300);
  } catch {
    return "";
  }
}
