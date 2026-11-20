import { describe, it, expect } from "vitest";
import { NextResponse } from "next/server";
import { copyAuthCookies } from "./auth-cookies";

describe("copyAuthCookies", () => {
  it("copies a rotated auth cookie (with options) onto the redirect response", () => {
    const from = NextResponse.next();
    from.cookies.set("sb-abc-auth-token", "rotated-value", {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      maxAge: 3600,
    });

    const dest = copyAuthCookies(
      NextResponse.redirect(new URL("https://www.zaviagent.com/workspace")),
      from,
    );

    const copied = dest.cookies.get("sb-abc-auth-token");
    expect(copied?.value).toBe("rotated-value");
    expect(copied?.httpOnly).toBe(true);
    expect(copied?.path).toBe("/");
  });

  it("copies ALL chunked sb-* cookies (dropping any chunk corrupts the session)", () => {
    const from = NextResponse.next();
    from.cookies.set("sb-abc-auth-token.0", "chunk-0", { path: "/" });
    from.cookies.set("sb-abc-auth-token.1", "chunk-1", { path: "/" });
    from.cookies.set("sb-abc-auth-token.2", "chunk-2", { path: "/" });

    const dest = copyAuthCookies(
      NextResponse.redirect(new URL("https://www.zaviagent.com/")),
      from,
    );

    expect(dest.cookies.get("sb-abc-auth-token.0")?.value).toBe("chunk-0");
    expect(dest.cookies.get("sb-abc-auth-token.1")?.value).toBe("chunk-1");
    expect(dest.cookies.get("sb-abc-auth-token.2")?.value).toBe("chunk-2");
  });

  it("is a no-op when the source set no cookies (signed-out redirect, no rotation)", () => {
    const from = NextResponse.next();
    const dest = copyAuthCookies(
      NextResponse.redirect(new URL("https://www.zaviagent.com/login")),
      from,
    );
    expect(dest.cookies.getAll()).toHaveLength(0);
  });

  it("returns the destination response (chainable)", () => {
    const from = NextResponse.next();
    const redirect = NextResponse.redirect(new URL("https://www.zaviagent.com/start"));
    expect(copyAuthCookies(redirect, from)).toBe(redirect);
  });
});
