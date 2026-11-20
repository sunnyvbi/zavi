import { apiFetch } from "@/lib/api";
import { ROLE_REFUSED_EVENT } from "@/lib/members";

export const ROLE_REFUSED_WORDS = "Only a workspace owner or admin can do this. Your role in this workspace may have changed.";
const ROLE_RULE_TEXT = /requires one of|Your role:/i;
export async function campaignFetch<T = unknown>(path: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try { response = await apiFetch(path, { ...options, retryOnNetworkError: !options?.method || options.method === "GET", headers: { "Content-Type": "application/json", ...options?.headers } }); }
  catch (e) { throw e instanceof Error && e.name !== "AbortError" ? Object.assign(e, { reply_lost: true }) : e; }
  let body;
  try { body = await response.json(); }
  catch { throw Object.assign(new Error("The server response could not be read. Refresh before retrying."), { reply_lost: true }); }
  if (!response.ok && response.status === 403 && body?.error?.code === "forbidden") {
    if (typeof window !== "undefined") window.dispatchEvent(new Event(ROLE_REFUSED_EVENT));
    const message = typeof body.error.message === "string" && body.error.message && !ROLE_RULE_TEXT.test(body.error.message) ? body.error.message : ROLE_REFUSED_WORDS;
    throw Object.assign(new Error(message), { status: 403, code: "forbidden" });
  }
  if (!response.ok) throw Object.assign(new Error(body?.error?.message ?? "The request could not be completed. Refresh before retrying."), { status: response.status, code: body?.error?.code as string | undefined, body });
  return body as T;
}

export function requestKey(previous: { signature: string; id: string } | null, path: string, body: unknown) {
  const signature = JSON.stringify([path, body]);
  return previous?.signature === signature ? previous : { signature, id: crypto.randomUUID() };
}
