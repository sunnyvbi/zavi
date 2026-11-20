import { CONNECTOR_TOKEN_PATTERN, ConnectorDelivery } from "@zavi/shared/db-guard";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const NEXT_TIMEOUT_MS = 40_000;
export const RESULT_TIMEOUT_MS = 20_000;
export const HEARTBEAT_TIMEOUT_MS = 10_000;
export const PAIR_TIMEOUT_MS = 15_000;

export type PairOutcome =
  | { kind: "paired"; token: string }
  | { kind: "rejected"; message: string }
  | { kind: "retry"; afterMs: number | null; why: string };

export type NextOutcome =
  | { kind: "delivery"; delivery: ConnectorDelivery }
  | { kind: "bad_delivery"; id: string | null; execution_token: string | null; reason: string }
  | { kind: "empty" }
  | { kind: "unauthorized" }
  | { kind: "retry"; afterMs: number | null; why: string };

export type PostOutcome = "delivered" | "stale" | "rejected" | "unauthorized" | { retry: true; afterMs: number | null; why: string };
export type HeartbeatOutcome = "ok" | "unauthorized" | { error: string };

export function retryAfterMs(h: string | null, now = Date.now()): number | null {
  if (!h) return null;
  const s = Number(h.trim());
  let ms: number;
  if (Number.isFinite(s)) ms = s * 1000;
  else {
    const d = Date.parse(h);
    if (Number.isNaN(d)) return null;
    ms = d - now;
  }
  return Math.max(1_000, Math.min(300_000, Math.round(ms)));
}

export function backoffMs(attempt: number, rand: () => number = Math.random, base = 1_000, cap = 60_000, floor = 250): number {
  const ceiling = Math.min(cap, base * 2 ** Math.min(attempt, 20));
  return Math.max(floor, Math.round(rand() * ceiling));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ZaviClient {
  constructor(
    private readonly api: string,
    private readonly version: string,
    private readonly token: () => string | null,
    private readonly fetchImpl: FetchLike = (u, i) => fetch(u, i),
  ) {}

  private headers(auth: boolean, json: boolean): Record<string, string> {
    const h: Record<string, string> = { "User-Agent": `zavi-connector/${this.version}`, Accept: "application/json" };
    if (json) h["Content-Type"] = "application/json";
    if (auth) {
      const t = this.token();
      if (t) h.Authorization = `Bearer ${t}`;
    }
    return h;
  }

  private async call(path: string, init: RequestInit, timeoutMs: number, outer?: AbortSignal): Promise<Response> {
    const signals = [AbortSignal.timeout(timeoutMs), ...(outer ? [outer] : [])];
    return this.fetchImpl(`${this.api}${path}`, { ...init, signal: AbortSignal.any(signals), redirect: "error" });
  }

  async pair(code: string, machine: string, version: string): Promise<PairOutcome> {
    let res: Response;
    try {
      res = await this.call("/api/connector/pair", { method: "POST", headers: this.headers(false, true), body: JSON.stringify({ code, machine, version }) }, PAIR_TIMEOUT_MS);
    } catch (e) {
      return { kind: "retry", afterMs: null, why: `could not reach Zavi (${(e as Error).name})` };
    }
    if (res.status === 200) {
      const body = (await res.json().catch(() => null)) as { token?: unknown } | null;
      if (typeof body?.token === "string" && CONNECTOR_TOKEN_PATTERN.test(body.token)) return { kind: "paired", token: body.token };
      return { kind: "retry", afterMs: null, why: "Zavi answered the pairing without a valid token" };
    }
    await res.body?.cancel().catch(() => undefined);
    if (res.status === 401 || res.status === 400) {
      return { kind: "rejected", message: "Zavi did not accept the pairing code: it is wrong, already used, or expired (codes last 30 minutes). Get a new code in Zavi and run the docker command again." };
    }
    if (res.status === 429) return { kind: "retry", afterMs: retryAfterMs(res.headers.get("retry-after")) ?? 60_000, why: "too many pairing attempts" };
    return { kind: "retry", afterMs: retryAfterMs(res.headers.get("retry-after")), why: `Zavi answered ${res.status}` };
  }

  async next(signal?: AbortSignal): Promise<NextOutcome> {
    let res: Response;
    try {
      res = await this.call("/api/connector/requests/next", { method: "GET", headers: this.headers(true, false) }, NEXT_TIMEOUT_MS, signal);
    } catch (e) {
      return { kind: "retry", afterMs: null, why: `could not reach Zavi (${(e as Error).name})` };
    }
    if (res.status === 204) {
      await res.body?.cancel().catch(() => undefined);
      return { kind: "empty" };
    }
    if (res.status === 200) {
      const raw = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      const parsed = ConnectorDelivery.safeParse(raw);
      if (parsed.success) return { kind: "delivery", delivery: parsed.data };
      const id = typeof raw?.id === "string" && UUID.test(raw.id) ? raw.id : null;
      const et = typeof raw?.execution_token === "string" && UUID.test(raw.execution_token) ? raw.execution_token : null;
      return { kind: "bad_delivery", id, execution_token: et, reason: "Zavi sent a request this connector does not understand. Update the connector or Zavi." };
    }
    await res.body?.cancel().catch(() => undefined);
    if (res.status === 401) return { kind: "unauthorized" };
    if (res.status === 429) return { kind: "retry", afterMs: retryAfterMs(res.headers.get("retry-after")) ?? 1_000, why: "another poll is already open" };
    return { kind: "retry", afterMs: retryAfterMs(res.headers.get("retry-after")), why: `Zavi answered ${res.status}` };
  }

  async postResult(id: string, body: string): Promise<PostOutcome> {
    let res: Response;
    try {
      res = await this.call(`/api/connector/requests/${encodeURIComponent(id)}/result`, { method: "POST", headers: this.headers(true, true), body }, RESULT_TIMEOUT_MS);
    } catch (e) {
      return { retry: true, afterMs: null, why: `could not reach Zavi (${(e as Error).name})` };
    }
    await res.body?.cancel().catch(() => undefined);
    if (res.status === 204 || res.status === 200) return "delivered";
    if (res.status === 409) return "stale";
    if (res.status === 400 || res.status === 413) return "rejected";
    if (res.status === 401) return "unauthorized";
    return { retry: true, afterMs: retryAfterMs(res.headers.get("retry-after")), why: `Zavi answered ${res.status}` };
  }

  async heartbeat(body: unknown): Promise<HeartbeatOutcome> {
    let res: Response;
    try {
      res = await this.call("/api/connector/heartbeat", { method: "POST", headers: this.headers(true, true), body: JSON.stringify(body) }, HEARTBEAT_TIMEOUT_MS);
    } catch (e) {
      return { error: `could not reach Zavi (${(e as Error).name})` };
    }
    await res.body?.cancel().catch(() => undefined);
    if (res.status === 200) return "ok";
    if (res.status === 401) return "unauthorized";
    return { error: `Zavi answered ${res.status}` };
  }
}
