import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u" } }, error: null }) },
  }),
}));

import { middleware } from "@/middleware";
import { NextRequest } from "next/server";

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://wmyc.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-test-key";
});

const go = async (path: string) => {
  const res = await middleware(new NextRequest(`http://localhost:3000${path}`));
  const loc = res.headers.get("location");
  return loc ? new URL(loc) : null;
};
const ID = "1A2B3C4D-0000-4000-8000-00000000ABCD";

describe("/approvals redirects", () => {
  it("bare /approvals → the Needs you tab, query carried, tab set last", async () => {
    const to = await go("/approvals?company=t1&tab=channels");
    expect(to?.pathname).toBe("/workspace");
    expect(to?.searchParams.get("tab")).toBe("needs-you");
    expect(to?.searchParams.get("company")).toBe("t1");
    expect(to?.searchParams.get("decision")).toBeNull();
  });

  it("/approvals/<uuid> → Needs you focused on that decision", async () => {
    const to = await go(`/approvals/${ID}`);
    expect(to?.searchParams.get("tab")).toBe("needs-you");
    expect(to?.searchParams.get("decision")).toBe(ID.toLowerCase());
  });

  it("any other subpath → Needs you with no decision", async () => {
    const to = await go("/approvals/history/anything");
    expect(to?.searchParams.get("tab")).toBe("needs-you");
    expect(to?.searchParams.get("decision")).toBeNull();
  });
});
