
import type { SupabaseClient, User } from "@supabase/supabase-js";

const REUSE_MS = 5_000;

let inflight: Promise<User | null> | null = null;
let confirmed: { user: User; at: number } | null = null;
let listening = false;
let generation = 0;

function listenForIdentityChanges(sb: SupabaseClient): void {
  if (listening) return;
  listening = true;
  sb.auth.onAuthStateChange((event, session) => {
    if (
      event === "SIGNED_OUT" ||
      event === "USER_UPDATED" ||
      (confirmed && session?.user?.id !== confirmed.user.id)
    ) {
      confirmed = null;
      inflight = null;
      generation += 1;
    }
  });
}

export async function getVerifiedUser(sb: SupabaseClient): Promise<User | null> {
  if (typeof window === "undefined") {
    const { data } = await sb.auth.getUser();
    return data.user ?? null;
  }
  listenForIdentityChanges(sb);
  if (confirmed && Date.now() - confirmed.at < REUSE_MS) return confirmed.user;
  if (inflight) return inflight;
  const mine = ++generation;
  const request: Promise<User | null> = (async () => {
    const {
      data: { session },
    } = await sb.auth.getSession();
    if (!session?.access_token) return null;
    const { data } = await sb.auth.getUser(session.access_token);
    const user = data.user ?? null;
    if (user && mine === generation) confirmed = { user, at: Date.now() };
    return user;
  })().finally(() => {
    if (mine === generation) inflight = null;
  });
  inflight = request;
  return request;
}
