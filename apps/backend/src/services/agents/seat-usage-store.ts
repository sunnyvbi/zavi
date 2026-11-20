
import { globalClient, recordSeatUsageRpc } from "@/services/tenant-client";

const REFRESH_MS = 20_000;
const STALE_MS = 6 * 3_600_000;

export type SeatRateLimitInfo = {
  status?: string;
  rateLimitType?: string;
  utilization?: number;
  resetsAt?: number;
};

type Window = { status: string; utilization: number | null; resetsAt: number | null; observedAt: number };

let cache = new Map<string, Map<string, Window>>();
let routingOn = false;
let timer: NodeJS.Timeout | null = null;
let inFlight: Promise<void> | null = null;

const inflight = new Map<string, Map<number, number>>();
const HOLD_TTL_MS = 30 * 60_000;
let holdSeq = 0;

function setWindow(seat: string, win: string, w: Window): void {
  const m = cache.get(seat) ?? new Map<string, Window>();
  const prev = m.get(win);
  if (!prev || prev.observedAt < w.observedAt) m.set(win, w);
  cache.set(seat, m);
}

export function recordSeatUsage(seat: string, info: SeatRateLimitInfo, now: number = Date.now()): void {
  if (!seat || !info || typeof info.status !== "string") return;
  const win = typeof info.rateLimitType === "string" && info.rateLimitType ? info.rateLimitType : "unknown";
  const utilization =
    typeof info.utilization === "number" && Number.isFinite(info.utilization)
      ? Math.min(1, Math.max(0, info.utilization))
      : null;
  const resetsAt =
    typeof info.resetsAt === "number" && Number.isFinite(info.resetsAt) && info.resetsAt > 0 ? info.resetsAt * 1000 : null;
  setWindow(seat, win, { status: info.status, utilization, resetsAt, observedAt: now });
  void (async () => {
    try {
      await recordSeatUsageRpc({
        seat,
        rateLimitType: win,
        status: info.status as string,
        utilization,
        resetsAtIso: resetsAt != null ? new Date(resetsAt).toISOString() : null,
        observedAtIso: new Date(now).toISOString(),
      });
    } catch (e) {
      console.warn(`[seat-usage] record failed for ${seat}: ${(e as Error).message}`);
    }
  })();
}

export async function refreshSeatUsage(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const since = new Date(Date.now() - STALE_MS).toISOString();
      const [{ data, error }, cfg] = await Promise.all([
        globalClient()
          .from("agent_auth_seat_usage")
          .select("seat, rate_limit_type, status, utilization, resets_at, observed_at")
          .gt("observed_at", since),
        globalClient().from("system_config").select("blob").eq("id", 1).maybeSingle(),
      ]);
      if (error) throw new Error(error.message);
      for (const r of (data ?? []) as Array<Record<string, unknown>>) {
        const observedAt = Date.parse(String(r.observed_at));
        if (!Number.isFinite(observedAt)) continue;
        const resets = r.resets_at ? Date.parse(String(r.resets_at)) : NaN;
        setWindow(String(r.seat), String(r.rate_limit_type), {
          status: String(r.status),
          utilization: typeof r.utilization === "number" ? r.utilization : r.utilization != null ? Number(r.utilization) : null,
          resetsAt: Number.isFinite(resets) ? resets : null,
          observedAt,
        });
      }
      if (!cfg.error) {
        const blob = (cfg.data as { blob?: Record<string, unknown> } | null)?.blob ?? {};
        routingOn = blob.seat_headroom_routing === true;
      }
    } catch (e) {
      console.warn(`[seat-usage] refresh failed, keeping cache: ${(e as Error).message}`);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function startSeatUsageRefresh(): void {
  if (timer) return;
  void refreshSeatUsage();
  timer = setInterval(() => void refreshSeatUsage(), REFRESH_MS);
  timer.unref?.();
}

export function stopSeatUsageRefresh(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export function seatHeadroomRoutingEnabled(): boolean {
  return routingOn;
}

export function holdSeat(seat: string, now: number = Date.now()): () => void {
  const id = ++holdSeq;
  const m = inflight.get(seat) ?? new Map<number, number>();
  m.set(id, now);
  inflight.set(seat, m);
  return () => {
    const cur = inflight.get(seat);
    if (!cur) return;
    cur.delete(id);
    if (cur.size === 0) inflight.delete(seat);
  };
}

function inflightCount(seat: string, now: number): number {
  let n = 0;
  for (const started of inflight.get(seat)?.values() ?? []) if (now - started < HOLD_TTL_MS) n++;
  return n;
}

const UNKNOWN_ROOM = 0.5;
const PER_RUN = 0.05;

export function seatRoom(seat: string, now: number = Date.now()): number {
  const wins = cache.get(seat);
  let room = UNKNOWN_ROOM;
  let seen = false;
  for (const w of wins?.values() ?? []) {
    if (now - w.observedAt > STALE_MS) continue;
    if (w.resetsAt != null && w.resetsAt <= now) continue;
    const r =
      w.status === "rejected" ? 0 : w.utilization != null ? 1 - w.utilization : w.status === "allowed_warning" ? 0.2 : UNKNOWN_ROOM;
    room = seen ? Math.min(room, r) : r;
    seen = true;
  }
  return room - inflightCount(seat, now) * PER_RUN;
}

export function orderByRoom(
  tokens: string[],
  isBenched: (t: string) => boolean,
  label: (t: string) => string,
  now: number = Date.now(),
): string[] {
  const hot = tokens.filter((t) => !isBenched(t));
  const benched = tokens.filter((t) => isBenched(t));
  const scored = hot.map((t, i) => ({ t, i, room: seatRoom(label(t), now) }));
  scored.sort((a, b) => b.room - a.room || a.i - b.i);
  return [...scored.map((s) => s.t), ...benched];
}

export function _resetSeatUsageForTest(entries?: { routing?: boolean }): void {
  cache = new Map();
  inflight.clear();
  routingOn = entries?.routing === true;
}
