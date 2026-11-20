
import { describe, it, expect, vi, beforeEach } from "vitest";
import { OPEN_ROLES, applyHref, generalApplyHref, APPLY_EMAIL } from "@/lib/careers";

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

describe("/careers is reachable signed-out", () => {
  it("does not auth-wall a signed-out candidate", async () => {
    const res = await middleware(new NextRequest("http://localhost:3000/careers"));
    const location = res.headers.get("location");
    expect(location, `/careers redirected to ${location}`).toBeNull();
    expect(res.status).toBe(200);
  });

  it("control — default-deny still holds for a product surface", async () => {
    const res = await middleware(new NextRequest("http://localhost:3000/workspace"));
    expect(res.headers.get("location")).toContain("/login");
  });
});

describe("OPEN_ROLES data integrity", () => {
  it("has unique slugs so #anchors resolve to one role each", () => {
    const slugs = OPEN_ROLES.map((r) => r.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("uses URL-safe slugs", () => {
    for (const role of OPEN_ROLES) {
      expect(role.slug, `slug "${role.slug}" is not URL-safe`).toMatch(
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      );
    }
  });

  it("never renders an empty listing card", () => {
    for (const role of OPEN_ROLES) {
      expect(role.title.trim().length, `${role.slug} has no title`).toBeGreaterThan(0);
      expect(role.summary.trim().length, `${role.slug} has no summary`).toBeGreaterThan(0);
      expect(role.whatYoullDo.length, `${role.slug} has no duties`).toBeGreaterThan(0);
      expect(role.lookingFor.length, `${role.slug} has no criteria`).toBeGreaterThan(0);
    }
  });
});

describe("apply links", () => {
  const role = {
    slug: "test-role",
    title: "Founding Engineer & Designer",
    team: "Engineering",
    location: "Remote",
    type: "Full-time",
    summary: "s",
    whatYoullDo: ["a"],
    lookingFor: ["b"],
  };

  it("percent-encodes the subject so an & in the title cannot truncate it", () => {
    const href = applyHref(role);
    expect(href).toContain("subject=Application%3A%20Founding%20Engineer%20%26%20Designer");
    expect(href.startsWith(`mailto:${APPLY_EMAIL}?`)).toBe(true);
  });

  it("builds a general application link", () => {
    expect(generalApplyHref()).toBe(
      `mailto:${APPLY_EMAIL}?subject=Open%20application`,
    );
  });
});
