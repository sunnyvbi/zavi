
import { apiUrl } from "./api";

export async function candidateFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  const headers = new Headers(opts.headers);
  if (!headers.has("Content-Type") && opts.body && typeof opts.body === "string") {
    headers.set("Content-Type", "application/json");
  }
  return fetch(apiUrl(path), { ...opts, headers });
}
