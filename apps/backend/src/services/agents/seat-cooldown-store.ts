
import { benchSeatCooldownRpc, globalClient } from "@/services/tenant-client";

const REFRESH_MS = 20_000;

let cache = new Map<string, number>();
let lastRefreshAt = 0;
let timer: NodeJS.Timeout | null = null;
let inFlight: Promise<void> | null = null;

export function isSeatCoolingShared(seat: string, now: number = Date.now()): boolean {
  const until = cache.get(seat);
  return until != null && until > now;
}

export function seatCooldownCacheAgeMs(): number {
  return lastRefreshAt === 0 ? Infinity : Date.now() - lastRefreshAt;
}

export function coolingSeatsSnapshot(now: number = Date.now()): Array<{
  seat: string;
  cooling_until: string;
}> {
  const out: Array<{ seat: string; cooling_until: string }> = [];
  for (const [seat, until] of cache) {
    if (until > now) out.push({ seat, cooling_until: new Date(until).toISOString() });
  }
  return out.sort((a, b) => a.seat.localeCompare(b.seat));
}

export function publishSeatCooldown(args: {
  seat: string;
  until: number;
  reason?: string;
}): void {
  const prev = cache.get(args.seat);
  if (prev == null || args.until > prev) cache.set(args.seat, args.until);

  void (async () => {
    try {
      await benchSeatCooldownRpc(args.seat, new Date(args.until).toISOString(), args.reason ?? "usage_limit");
    } catch (e) {
      console.warn(
        `[seat-cooldown] publish failed for ${args.seat} (local cache still set): ${(e as Error).message}`,
      );
    }
  })();
}

export async function refreshSeatCooldowns(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const nowISO = new Date().toISOString();
      const { data, error } = await globalClient()
        .from("agent_auth_seat_cooldown")
        .select("seat, cooling_until")
        .gt("cooling_until", nowISO);
      if (error) throw new Error(error.message);
      const now = Date.now();
      const next = new Map<string, number>();
      for (const row of data ?? []) {
        const until = Date.parse((row as { cooling_until: string }).cooling_until);
        if (Number.isFinite(until) && until > now) {
          next.set((row as { seat: string }).seat, until);
        }
      }
      for (const [seat, until] of cache) {
        if (until > now && until > (next.get(seat) ?? 0)) next.set(seat, until);
      }
      cache = next;
      lastRefreshAt = Date.now();
    } catch (e) {
      console.warn(
        `[seat-cooldown] refresh failed, keeping ${cache.size} cached entr(ies): ${(e as Error).message}`,
      );
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function startSeatCooldownRefresh(): void {
  if (timer) return;
  void refreshSeatCooldowns();
  timer = setInterval(() => void refreshSeatCooldowns(), REFRESH_MS);
  timer.unref?.();
}

export function stopSeatCooldownRefresh(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export function _setSeatCooldownsForTest(entries: Array<[string, number]>): void {
  cache = new Map(entries);
  lastRefreshAt = entries.length ? Date.now() : 0;
}
