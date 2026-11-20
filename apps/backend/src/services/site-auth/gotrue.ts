
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { GoTrueEmailThrottled } from "./errors";
import type { GoTrue, GoTrueSession, GoTrueUser, VerifyType } from "./types";

export interface ShardAuthConfig {
  url: string;
  anonKey: string;
  serviceKey: string;
}

const OPTS = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } } as const;

function sess(s: Session | null | undefined): GoTrueSession | null {
  if (!s?.access_token || !s.refresh_token || !s.user?.id) return null;
  return {
    access_token: s.access_token,
    refresh_token: s.refresh_token,
    expires_at: s.expires_at ?? Math.floor(Date.now() / 1000) + (s.expires_in ?? 3600),
    expires_in: s.expires_in ?? 3600,
    token_type: s.token_type ?? "bearer",
    user_id: s.user.id,
  };
}

function check(error: { message: string } | null | undefined, what: string): void {
  if (error) throw new Error(`gotrue ${what}: ${error.message}`);
}

function checkSend(error: { message: string; status?: number; code?: string } | null | undefined, what: string): void {
  if (error && (error.status === 429 || error.code === "over_email_send_rate_limit")) {
    throw new GoTrueEmailThrottled(`gotrue ${what}: ${error.message}`);
  }
  check(error, what);
}

function tokenHashOf(data: { properties?: { hashed_token?: unknown } | null } | null | undefined): string {
  const hash = data?.properties?.hashed_token;
  if (typeof hash !== "string" || !hash) throw new Error("gotrue generateLink: no token");
  return hash;
}

export function createGoTrue(cfg: ShardAuthConfig): GoTrue {
  const admin = (): SupabaseClient => createClient(cfg.url, cfg.serviceKey, OPTS);
  const pub = (): SupabaseClient => createClient(cfg.url, cfg.anonKey, OPTS);
  return {
    async createUser({ id, email, password, emailConfirm }) {
      const { error } = await admin().auth.admin.createUser({ id, email, password, email_confirm: emailConfirm });
      check(error, "createUser");
    },
    async getUserById(id) {
      const { data, error } = await admin().auth.admin.getUserById(id);
      if (error) {
        if ((error as { status?: number }).status === 404) return null;
        throw new Error(`gotrue getUserById: ${error.message}`);
      }
      const u = data.user;
      return u ? { id: u.id, email: u.email ?? null, emailConfirmedAt: u.email_confirmed_at ?? null } : null;
    },
    async updateUserById(id, a) {
      const { error } = await admin().auth.admin.updateUserById(id, {
        ...(a.password !== undefined ? { password: a.password } : {}),
        ...(a.email !== undefined ? { email: a.email } : {}),
        ...(a.emailConfirm !== undefined ? { email_confirm: a.emailConfirm } : {}),
      });
      check(error, "updateUserById");
    },
    async deleteUser(id) {
      const { error } = await admin().auth.admin.deleteUser(id);
      if (error && (error as { status?: number }).status !== 404) throw new Error(`gotrue deleteUser: ${error.message}`);
    },
    async signInWithPassword(email, password) {
      const { data, error } = await pub().auth.signInWithPassword({ email, password });
      return error ? null : sess(data.session);
    },
    async magicLinkTokenHash(aliasEmail) {
      const { data, error } = await admin().auth.admin.generateLink({ type: "magiclink", email: aliasEmail });
      check(error, "generateLink");
      return tokenHashOf(data);
    },
    async recoveryTokenHash(aliasEmail) {
      const { data, error } = await admin().auth.admin.generateLink({ type: "recovery", email: aliasEmail });
      check(error, "generateLink");
      return tokenHashOf(data);
    },
    async verifyOtp(tokenHash: string, type: VerifyType) {
      const { data, error } = await pub().auth.verifyOtp({ token_hash: tokenHash, type });
      return error ? null : sess(data.session);
    },
    async refresh(refreshToken) {
      const { data, error } = await pub().auth.refreshSession({ refresh_token: refreshToken });
      return error ? null : sess(data.session);
    },
    async getUser(accessToken) {
      const { data, error } = await admin().auth.getUser(accessToken);
      if (error || !data.user) return null;
      const u = data.user;
      return { id: u.id, email: u.email ?? null, emailConfirmedAt: u.email_confirmed_at ?? null } satisfies GoTrueUser;
    },
    async signOut(accessToken, scope) {
      const { error } = await admin().auth.admin.signOut(accessToken, scope);
      check(error, "signOut");
    },
    async sendMagicLink(aliasEmail) {
      const { error } = await pub().auth.signInWithOtp({ email: aliasEmail, options: { shouldCreateUser: false } });
      checkSend(error, "otp");
    },
    async sendRecovery(aliasEmail) {
      const { error } = await pub().auth.resetPasswordForEmail(aliasEmail);
      checkSend(error, "recover");
    },
    async removeObjects(names) {
      const { error } = await admin().storage.from("site-files").remove(names);
      check(error, "storage remove");
    },
  };
}
