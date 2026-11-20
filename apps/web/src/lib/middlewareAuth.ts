import type { NextRequest } from "next/server";

function projectRef(): string | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return null;
  return /^https?:\/\/([^.]+)\./.exec(url)?.[1] ?? null;
}

export function hasAuthCookie(req: NextRequest): boolean {
  const ref = projectRef();
  if (!ref) return false;
  const exact = `sb-${ref}-auth-token`;
  return req.cookies
    .getAll()
    .some((c) => c.name === exact || c.name.startsWith(`${exact}.`));
}

export async function withTimeout<T>(
  p: PromiseLike<T>,
  ms: number,
): Promise<
  { ok: true; value: T } | { ok: false; reason: "timeout" | "threw" }
> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error("mw-timeout"));
      }, ms);
    });
    const value = await Promise.race([p, timeout]);
    return { ok: true, value };
  } catch {
    return { ok: false, reason: timedOut ? "timeout" : "threw" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
