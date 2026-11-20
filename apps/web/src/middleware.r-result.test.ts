
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
  }),
}));

import { middleware } from "@/middleware";
import { NextRequest } from "next/server";

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://wmyc.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-test-key";
});

const go = (path: string) => middleware(new NextRequest(`http://localhost:3000${path}`));

describe("/r/<id> is public", () => {
  it.each(["/r/abc", "/r/fx7Kq2mZr9TbLw4N", "/r/fx7Kq2mZr9TbLw4N/opengraph-image"])(
    "does not auth-wall %s",
    async (path) => {
      const res = await go(path);
      expect(res.headers.get("location"), `${path} redirected`).toBeNull();
      expect(res.status).toBe(200);
    },
  );
});

describe("paths that merely start with /r stay gated", () => {
  it.each(["/roles", "/roles/123/edit", "/r"])("redirects a signed-out visitor away from %s", async (path) => {
    const res = await go(path);
    expect(res.headers.get("location")).toContain("/login");
  });
});
