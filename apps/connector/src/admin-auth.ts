import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Store } from "./store";

export const SESSION_COOKIE = "zc_session";
export const SESSION_IDLE_MS = 12 * 3600 * 1000;
const MAX_SESSIONS = 20;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
const TOKEN_PREFIX = "zcadm_";

export const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

export function newAdminToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

export function resetAdminToken(store: Store): string {
  const token = newAdminToken();
  store.update((s) => ({ ...s, admin_token_hash: sha256(token), admin_epoch: s.admin_epoch + 1 }));
  return token;
}

export function ensureAdminToken(store: Store): string | null {
  if (store.read().admin_token_hash) return null;
  return resetAdminToken(store);
}

function equalHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

type Session = { csrf: string; epoch: number; lastSeen: number };

export class AdminAuth {
  private readonly sessions = new Map<string, Session>();
  private failures: number[] = [];

  constructor(
    private readonly store: Store,
    private readonly now: () => number = () => Date.now(),
  ) {}

  loginLocked(): boolean {
    const t = this.now();
    this.failures = this.failures.filter((f) => t - f < LOGIN_WINDOW_MS);
    return this.failures.length >= LOGIN_MAX_FAILURES;
  }

  login(token: string): string | null {
    if (this.loginLocked()) return null;
    const st = this.store.read();
    if (!st.admin_token_hash || typeof token !== "string" || token.length > 200 || !equalHex(sha256(token.trim()), st.admin_token_hash)) {
      this.failures.push(this.now());
      return null;
    }
    this.failures = [];
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
      if (oldest) this.sessions.delete(oldest[0]);
    }
    const id = randomBytes(32).toString("base64url");
    this.sessions.set(id, { csrf: randomBytes(32).toString("base64url"), epoch: st.admin_epoch, lastSeen: this.now() });
    return id;
  }

  session(id: string | null): { id: string; csrf: string } | null {
    if (!id || !/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
    const s = this.sessions.get(id);
    if (!s) return null;
    if (this.now() - s.lastSeen > SESSION_IDLE_MS || s.epoch !== this.store.read().admin_epoch) {
      this.sessions.delete(id);
      return null;
    }
    s.lastSeen = this.now();
    return { id, csrf: s.csrf };
  }

  logout(id: string): void {
    this.sessions.delete(id);
  }
}
