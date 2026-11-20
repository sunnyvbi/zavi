import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => ({ tenant_id: "t1", user_id: "u1" })),
}));

import {
  isSignInUrl,
  mobileHandoff,
  mobileOpen,
  mobileReturnMiddleware,
  providerOfPath,
  signHandoff,
  toAppReturn,
  verifyHandoff,
} from "../mobile-return";

const WEB = "https://www.zaviagent.com";

async function serve(app: express.Express) {
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/connectors", mobileReturnMiddleware);
  app.post("/api/connectors/mobile/handoff", mobileHandoff);
  app.get("/api/connectors/mobile/open", mobileOpen);
  app.get("/api/connectors/x_social/callback", (_req, res) =>
    res.redirect(302, `${WEB}/workspace?tab=settings&x_social=connected`),
  );
  app.get("/api/connectors/meta-ads/callback", (_req, res) =>
    res
      .type("html")
      .send(`<!doctype html><html><body><script>var t=${JSON.stringify(`${WEB}/workspace?tab=settings&meta_ads=connected`)};</script></body></html>`),
  );
  app.get("/api/connectors/list", (_req, res) => res.json({ ok: true }));
  app.get("/api/connectors/linkedin_social/callback", (_req, res) =>
    res.status(403).json({ error: { code: "invalid_state", message: "OAuth state invalid, expired, or replayed." } }),
  );
  app.get("/api/connectors/tiktok/callback", (_req, res) =>
    res.status(400).type("text/plain").send("TikTok did not return code and state."),
  );
  app.get("/api/connectors/google-ads/callback", (_req, res) =>
    res.status(400).type("html").send("<!doctype html><html><body><h1>Permission denied</h1><p>Google returned error: access_denied.</p></body></html>"),
  );
  app.get("/api/connectors/slack/callback", (_req, res) =>
    res.redirect(302, `${WEB}/workspace?tab=settings&slack_error=invalid_state`),
  );
  app.get("/api/connectors/composio/youtube/return", (_req, res) =>
    res.redirect(302, `${WEB}/workspace?tab=settings&composio_error=youtube&code=missing_params`),
  );
  return app;
}

beforeEach(() => {
  process.env.MOBILE_HANDOFF_SECRET = "test-secret-at-least-32-characters-long";
  process.env.WEB_ORIGIN = WEB;
  delete process.env.BACKEND_PUBLIC_URL;
});

describe("handoff signature", () => {
  it("verifies its own signature and rejects a changed url or an expired link", () => {
    const now = Date.now();
    const { exp, sig } = signHandoff("https://x.com/i/oauth2/authorize?a=1", now);
    expect(verifyHandoff("https://x.com/i/oauth2/authorize?a=1", exp, sig, now)).toBe(true);
    expect(verifyHandoff("https://evil.example/?a=1", exp, sig, now)).toBe(false);
    expect(verifyHandoff("https://x.com/i/oauth2/authorize?a=1", exp, sig, now + 10 * 60 * 1000)).toBe(false);
  });

  it("maps only the web settings landing to the app", () => {
    expect(toAppReturn(`${WEB}/workspace?tab=settings&slack=connected`, WEB)).toBe(
      "zavi://connectors/done?tab=settings&slack=connected",
    );
    expect(toAppReturn("https://evil.example/workspace?x", WEB)).toBeNull();
  });
});

describe("callback paths", () => {
  it("names the connector from its callback path", () => {
    expect(providerOfPath("/slack/callback")).toBe("slack");
    expect(providerOfPath("/meta-ads/callback")).toBe("meta_ads");
    expect(providerOfPath("/composio/youtube/return")).toBe("composio_youtube");
    expect(providerOfPath("/x_social/callback")).toBe("x_social");
    expect(providerOfPath("/meta-ads/finalize")).toBeNull();
    expect(providerOfPath("/")).toBeNull();
  });
});

describe("mobile return flow", () => {
  it("handoff -> open sets the cookie and bounces to the provider; the callback then lands in the app", async () => {
    const { base, close } = await serve(makeApp());
    process.env.BACKEND_PUBLIC_URL = base;
    const provider = `https://x.com/i/oauth2/authorize?state=s&redirect_uri=${encodeURIComponent(`${base}/api/connectors/x_social/callback`)}`;
    try {
      const h = await fetch(`${base}/api/connectors/mobile/handoff`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: provider }),
      });
      const { open_url } = (await h.json()) as { open_url: string };
      expect(open_url).toContain("/api/connectors/mobile/open?");

      const o = await fetch(open_url, { redirect: "manual" });
      expect(o.status).toBe(302);
      expect(o.headers.get("location")).toBe(provider);
      const cookie = (o.headers.get("set-cookie") ?? "").split(";")[0];
      expect(cookie).toBe("zavi_mobile_return=1");

      const cb = await fetch(`${base}/api/connectors/x_social/callback`, { redirect: "manual", headers: { cookie } });
      expect(cb.headers.get("location")).toBe("zavi://connectors/done?tab=settings&x_social=connected");

      const html = await (await fetch(`${base}/api/connectors/meta-ads/callback`, { headers: { cookie } })).text();
      expect(html).toContain("zavi://connectors/done?tab=settings&meta_ads=connected");
      expect(html).toContain("Return to Zavi");
      expect(html).not.toContain(`${WEB}/workspace?`);

      const json = await (await fetch(`${base}/api/connectors/list`, { headers: { cookie } })).json();
      expect(json).toEqual({ ok: true });
    } finally {
      close();
    }
  });

  it("sends every failure shape back to the app with its reason", async () => {
    const { base, close } = await serve(makeApp());
    const cookie = "zavi_mobile_return=1";
    const loc = async (path: string) =>
      (await fetch(`${base}${path}`, { redirect: "manual", headers: { cookie } })).headers.get("location");
    try {
      expect(await loc("/api/connectors/linkedin_social/callback")).toBe(
        "zavi://connectors/done?tab=settings&connect_error=invalid_state&provider=linkedin_social",
      );
      expect(await loc("/api/connectors/tiktok/callback")).toBe(
        "zavi://connectors/done?tab=settings&connect_error=missing_params&provider=tiktok",
      );
      expect(await loc("/api/connectors/google-ads/callback")).toBe(
        "zavi://connectors/done?tab=settings&connect_error=permission_denied&provider=google_ads",
      );
      expect(await loc("/api/connectors/slack/callback")).toBe("zavi://connectors/done?tab=settings&slack_error=invalid_state");
      expect(await loc("/api/connectors/composio/youtube/return")).toBe(
        "zavi://connectors/done?tab=settings&composio_error=youtube&code=missing_params",
      );
    } finally {
      close();
    }
  });

  it("leaves the web flow alone when the browser was not opened by the app", async () => {
    const { base, close } = await serve(makeApp());
    try {
      const cb = await fetch(`${base}/api/connectors/x_social/callback`, { redirect: "manual" });
      expect(cb.headers.get("location")).toBe(`${WEB}/workspace?tab=settings&x_social=connected`);
      const err = await fetch(`${base}/api/connectors/linkedin_social/callback`, { redirect: "manual" });
      expect(err.status).toBe(403);
    } finally {
      close();
    }
  });

  it("refuses an unsigned or tampered open link (no open redirect)", async () => {
    const { base, close } = await serve(makeApp());
    try {
      const r = await fetch(`${base}/api/connectors/mobile/open?u=${encodeURIComponent("https://evil.example")}&exp=9999999999&sig=bad`, {
        redirect: "manual",
      });
      expect(r.status).toBe(400);
      expect(r.headers.get("set-cookie")).toBeNull();
    } finally {
      close();
    }
  });

  it("signs only a connector sign-in page that returns to this backend", async () => {
    const { base, close } = await serve(makeApp());
    try {
      const h = await fetch(`${base}/api/connectors/mobile/handoff`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://evil.example/login" }),
      });
      expect(h.status).toBe(400);

      process.env.BACKEND_PUBLIC_URL = "https://api.zaviagent.com";
      const cb = encodeURIComponent("https://api.zaviagent.com/api/connectors/x/callback");
      const evil = encodeURIComponent("https://evil.example/cb");
      expect(isSignInUrl(`https://evil.example/oauth?redirect_uri=${cb}`)).toBe(false);
      expect(isSignInUrl(`https://slack.com.evil.example/oauth/v2/authorize?redirect_uri=${cb}`)).toBe(false);
      expect(isSignInUrl("https://docs.google.com/forms/d/e/x/viewform")).toBe(false);
      expect(isSignInUrl("https://github.com/attacker/phishing")).toBe(false);
      expect(isSignInUrl("https://github.com/apps/attacker-app/installations/new")).toBe(false);
      expect(isSignInUrl(`https://user:pw@slack.com/oauth/v2/authorize?redirect_uri=${cb}`)).toBe(false);
      expect(isSignInUrl(`https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=${evil}`)).toBe(false);
      expect(isSignInUrl("https://accounts.google.com/o/oauth2/v2/auth?client_id=1")).toBe(false);
      const preview = encodeURIComponent("https://api.zaviagent.com/api/workspace/engineer-preview/r1/x");
      expect(isSignInUrl(`https://slack.com/oauth/v2/authorize?redirect_uri=${preview}`)).toBe(false);
      expect(isSignInUrl(`https://slack.com/oauth/v2/authorize?redirect_uri=${cb}&redirect_uri=${evil}`)).toBe(false);
      expect(isSignInUrl("https://backend.composio.dev/api/v3/s/abc_123")).toBe(false);
      for (const ok of [
        `https://accounts.google.com/o/oauth2/v2/auth?state=s&redirect_uri=${cb}`,
        `https://slack.com/oauth/v2/authorize?state=s&redirect_uri=${cb}`,
        `https://www.facebook.com/v25.0/dialog/oauth?state=s&redirect_uri=${cb}`,
        `https://www.linkedin.com/oauth/v2/authorization?state=s&redirect_uri=${cb}`,
        `https://business-api.tiktok.com/portal/auth?state=s&redirect_uri=${cb}`,
        `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=s&redirect_uri=${cb}`,
        "https://github.com/apps/zavi-engineer/installations/new?state=s",
      ]) {
        expect(isSignInUrl(ok)).toBe(true);
      }
      delete process.env.BACKEND_PUBLIC_URL;
      expect(isSignInUrl(`https://slack.com/oauth/v2/authorize?state=s&redirect_uri=${cb}`)).toBe(false);
    } finally {
      close();
    }
  });

  it("fails closed without its own secret, never borrowing the service-role key", async () => {
    delete process.env.MOBILE_HANDOFF_SECRET;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-that-must-never-sign-a-link";
    const { base, close } = await serve(makeApp());
    process.env.BACKEND_PUBLIC_URL = base;
    try {
      const h = await fetch(`${base}/api/connectors/mobile/handoff`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: `https://x.com/i/oauth2/authorize?state=s&redirect_uri=${encodeURIComponent(`${base}/api/connectors/x_social/callback`)}` }),
      });
      expect(h.status).toBe(503);
      const { exp, sig } = signHandoff("https://x.com/i/oauth2/authorize?state=s");
      expect(verifyHandoff("https://x.com/i/oauth2/authorize?state=s", exp, sig)).toBe(false);
    } finally {
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      close();
    }
  });
});
