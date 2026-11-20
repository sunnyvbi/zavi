import { describe, expect, it, vi } from "vitest";

import { mintActionLink } from "@/email/sendAuthEmail";

const SUPA = "https://wmycgyjsenvgtczlupoe.supabase.co/auth/v1/verify";
const LOCAL = "http://localhost:3010/auth/callback?next=%2Freset-password";
const SITE = "https://www.zaviagent.com";

function actionLink(redirectTo: string): string {
  return `${SUPA}?token=abc&type=recovery&redirect_to=${encodeURIComponent(redirectTo)}`;
}

function svcWith(responses: Array<{ redirectTo: string; hashed_token?: string | null }>) {
  const calls: string[] = [];
  let i = 0;
  const generateLink = vi.fn(async (args: { options?: { redirectTo?: string } }) => {
    calls.push(args.options?.redirectTo ?? "");
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return {
      error: null,
      data: {
        properties: {
          action_link: actionLink(r.redirectTo),
          ...(r.hashed_token === undefined ? { hashed_token: "hash-xyz" } : { hashed_token: r.hashed_token }),
        },
      },
    };
  });
  return { svc: { auth: { admin: { generateLink } } }, calls, generateLink };
}

describe("minting a recovery link when Supabase honours the redirect", () => {
  it("returns Supabase's own action_link untouched, with one round trip", async () => {
    const { svc, generateLink } = svcWith([{ redirectTo: LOCAL }]);

    const url = await mintActionLink(svc as never, "recovery", "a@example.com", LOCAL);

    expect(url).toBe(actionLink(LOCAL));
    expect(generateLink).toHaveBeenCalledTimes(1);
  });
});

describe("minting a recovery link when Supabase downgrades it to the Site URL", () => {
  it("keeps the origin that was asked for instead of relocating to production", async () => {
    const { svc, generateLink } = svcWith([{ redirectTo: SITE }]);

    const url = await mintActionLink(svc as never, "recovery", "a@example.com", LOCAL);

    const parsed = new URL(url);
    expect(parsed.origin).toBe("http://localhost:3010");
    expect(parsed.pathname).toBe("/auth/callback");
    expect(parsed.searchParams.get("next")).toBe("/reset-password");
    expect(parsed.searchParams.get("token_hash")).toBe("hash-xyz");
    expect(parsed.searchParams.get("type")).toBe("recovery");
    expect(url.startsWith(SITE)).toBe(false);
    expect(generateLink).toHaveBeenCalledTimes(1);
  });

  it("falls back to re-minting on the substituted origin when there is no hashed_token", async () => {
    const { svc, calls, generateLink } = svcWith([
      { redirectTo: SITE, hashed_token: null },
      { redirectTo: SITE, hashed_token: null },
    ]);

    const url = await mintActionLink(svc as never, "recovery", "a@example.com", LOCAL);

    expect(generateLink).toHaveBeenCalledTimes(2);
    expect(calls[1]).toBe(`${SITE}/auth/callback?next=%2Freset-password`);
    expect(url).toBe(actionLink(SITE));
  });
});

const TENANT_HOSTS = [
  "promo.zaviagent.com",
  "acme-co.zaviagent.com",
  "a1.zaviagent.com",
  "zaviagent.com",
];

describe("minting a recovery link for a host the tenant fleet can claim", () => {
  it.each(TENANT_HOSTS)(
    "never hands the recovery token to %s, whatever the label",
    async (host) => {
      const asked = `https://${host}/auth/callback?next=%2Freset-password`;
      const { svc, calls, generateLink } = svcWith([{ redirectTo: SITE }, { redirectTo: SITE }]);

      const url = await mintActionLink(svc as never, "recovery", "victim@example.com", asked);

      expect(url).not.toContain("hash-xyz");
      expect(url).not.toContain("token_hash");
      expect(new URL(url).hostname).not.toBe(host);
      expect(calls[1]).toBe(`${SITE}/auth/callback?next=%2Freset-password`);
      expect(generateLink).toHaveBeenCalledTimes(2);
    },
  );

  it("refuses the loopback shortcut on a production backend", async () => {
    const prior = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      const { svc } = svcWith([{ redirectTo: SITE }, { redirectTo: SITE }]);

      const url = await mintActionLink(svc as never, "recovery", "victim@example.com", LOCAL);

      expect(url).not.toContain("token_hash");
      expect(url).not.toContain("hash-xyz");
    } finally {
      process.env.NODE_ENV = prior;
    }
  });
});
