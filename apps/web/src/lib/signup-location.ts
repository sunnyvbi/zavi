import { apiUrl } from "@/lib/api";
export type SignupLocationTicket = { payload: string; signature: string };
export async function prepareSignupLocation(
  email: string,
): Promise<SignupLocationTicket | null> {
  try {
    const res = await fetch("/api/auth/signup-location", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    return (await res.json()).ticket ?? null;
  } catch {
    return null;
  }
}
let primed: {
  email: string;
  at: number;
  ticket: SignupLocationTicket | null;
} | null = null;
export function primeSignupLocation(email: string): void {
  const key = email.trim().toLowerCase();
  if (primed?.email === key && Date.now() - primed.at < 40000) return;
  const entry: NonNullable<typeof primed> = { email: key, at: Date.now(), ticket: null };
  primed = entry;
  void prepareSignupLocation(key).then((t) => {
    entry.ticket = t;
  });
}
export function readySignupLocation(email: string): SignupLocationTicket | null {
  const key = email.trim().toLowerCase();
  const fresh = primed?.email === key && Date.now() - primed.at < 45000;
  if (!fresh) primeSignupLocation(key);
  return fresh ? (primed?.ticket ?? null) : null;
}
export async function deliverSignupLocation(
  userId: string,
  ticket: SignupLocationTicket,
  accessToken?: string,
): Promise<void> {
  try {
    await fetch(apiUrl("/api/auth/signup-location"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify({ user_id: userId, ...ticket }),
      keepalive: true,
      signal: AbortSignal.timeout(5000),
    });
  } catch {
  }
}
