
import type { NextResponse } from "next/server";

export function copyAuthCookies(dest: NextResponse, from: NextResponse): NextResponse {
  for (const cookie of from.cookies.getAll()) {
    dest.cookies.set(cookie);
  }
  return dest;
}
