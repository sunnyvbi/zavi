
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  botScopes,
  BOT_SCOPES_VERSION,
  grantedScopesVersion,
  missingScopes,
  exchangeCode,
} from "../oauth";

const V1 = [
  "channels:read",
  "groups:read",
  "channels:history",
  "groups:history",
  "users:read",
  "users:read.email",
  "app_mentions:read",
  "chat:write",
  "reactions:write",
  "files:write",
];
const V2 = [...V1, "channels:join", "pins:read", "files:read", "usergroups:read", "team:read"];
const V3 = [...V2, "im:history", "im:read", "im:write"];
const V4 = [...V3, "mpim:history", "mpim:read"];

describe("missingScopes — scope-drift diff", () => {
  it("returns [] when the granted set matches BOT_SCOPES exactly", () => {
    expect(missingScopes(botScopes())).toEqual([]);
  });

  it("returns the v1→current delta when only legacy v1 scopes are granted", () => {
    const v1 = [
      "channels:read",
      "groups:read",
      "channels:history",
      "groups:history",
      "users:read",
      "users:read.email",
      "app_mentions:read",
      "chat:write",
      "reactions:write",
      "files:write",
    ];
    expect(missingScopes(v1)).toEqual([
      "channels:join",
      "pins:read",
      "files:read",
      "usergroups:read",
      "team:read",
      "im:history",
      "im:read",
      "im:write",
      "mpim:history",
      "mpim:read",
      "mpim:write",
      "channels:manage",
    ]);
  });

  it("returns the v2→current delta (DM + MPIM scopes) when only v2 scopes are granted", () => {
    const v2 = [
      "channels:read",
      "groups:read",
      "channels:history",
      "groups:history",
      "users:read",
      "users:read.email",
      "app_mentions:read",
      "chat:write",
      "reactions:write",
      "files:write",
      "channels:join",
      "pins:read",
      "files:read",
      "usergroups:read",
      "team:read",
    ];
    expect(missingScopes(v2)).toEqual([
      "im:history",
      "im:read",
      "im:write",
      "mpim:history",
      "mpim:read",
      "mpim:write",
      "channels:manage",
    ]);
  });

  it("returns the v3→current delta (MPIM scopes) when only v3 scopes are granted", () => {
    const v3 = [
      "channels:read",
      "groups:read",
      "channels:history",
      "groups:history",
      "users:read",
      "users:read.email",
      "app_mentions:read",
      "chat:write",
      "reactions:write",
      "files:write",
      "channels:join",
      "pins:read",
      "files:read",
      "usergroups:read",
      "team:read",
      "im:history",
      "im:read",
      "im:write",
    ];
    expect(missingScopes(v3)).toEqual([
      "mpim:history",
      "mpim:read",
      "mpim:write",
      "channels:manage",
    ]);
  });

  it("returns the v4→current delta (mpim:write + channels:manage) when only v4 scopes are granted", () => {
    const v4 = [
      "channels:read",
      "groups:read",
      "channels:history",
      "groups:history",
      "users:read",
      "users:read.email",
      "app_mentions:read",
      "chat:write",
      "reactions:write",
      "files:write",
      "channels:join",
      "pins:read",
      "files:read",
      "usergroups:read",
      "team:read",
      "im:history",
      "im:read",
      "im:write",
      "mpim:history",
      "mpim:read",
    ];
    expect(missingScopes(v4)).toEqual(["mpim:write", "channels:manage"]);
  });

  it("returns the v5→v6 delta (channels:manage — auto-create digest channel) when only v5 scopes are granted", () => {
    const v5 = botScopes().filter((s) => s !== "channels:manage");
    expect(missingScopes(v5)).toEqual(["channels:manage"]);
  });

  it("returns missing scopes in BOT_SCOPES order, NOT alphabetical", () => {
    const have = botScopes().filter(
      (s) => s !== "channels:read" && s !== "team:read",
    );
    const out = missingScopes(have);
    expect(out).toEqual(["channels:read", "team:read"]);
  });

  it("treats unknown scopes in the granted set as no-op (forward-compat)", () => {
    const granted = [...botScopes(), "tomorrow:scope:we:dont:know"];
    expect(missingScopes(granted)).toEqual([]);
  });
});

describe("BOT_SCOPES_VERSION — v6 (channels:manage for auto-create digest channel)", () => {
  it("is the locked v6 integer", () => {
    expect(BOT_SCOPES_VERSION).toBe(6);
  });

  it("requests channels:manage (create the digest channel + invite the installer)", () => {
    expect(botScopes()).toContain("channels:manage");
  });

  it("still requests mpim:write (group-DM open/send)", () => {
    expect(botScopes()).toContain("mpim:write");
  });

  it("does NOT request incoming_webhook (welcome intro is opt-in via a DM picker)", () => {
    expect(botScopes()).not.toContain("incoming_webhook");
  });
});

describe("grantedScopesVersion — spec version derived from granted scopes", () => {
  it("maps the full BOT_SCOPES set to the current BOT_SCOPES_VERSION (drift guard)", () => {
    expect(grantedScopesVersion(botScopes())).toBe(BOT_SCOPES_VERSION);
  });

  it("maps each historical cumulative set to its version", () => {
    expect(grantedScopesVersion(V1)).toBe(1);
    expect(grantedScopesVersion(V2)).toBe(2);
    expect(grantedScopesVersion(V3)).toBe(3);
    expect(grantedScopesVersion(V4)).toBe(4);
  });

  it("caps at the highest COMPLETE version — extra higher scopes don't inflate it", () => {
    const v2PlusStrayV4 = [...V2, "mpim:read"];
    expect(grantedScopesVersion(v2PlusStrayV4)).toBe(2);
  });

  it("returns 0 when even the v1 base is incomplete", () => {
    const missingBase = V1.filter((s) => s !== "chat:write");
    expect(grantedScopesVersion(missingBase)).toBe(0);
  });

  it("ignores unknown scopes (forward-compat)", () => {
    expect(grantedScopesVersion([...botScopes(), "tomorrow:scope"])).toBe(
      BOT_SCOPES_VERSION,
    );
  });
});

describe("exchangeCode — captures the installer id for the welcome DM", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("parses authed_user.id from oauth.v2.access", async () => {
    vi.stubEnv("SLACK_CLIENT_ID", "cid");
    vi.stubEnv("SLACK_CLIENT_SECRET", "csecret");
    vi.stubEnv("BACKEND_PUBLIC_URL", "https://api.example.com");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          ok: true,
          access_token: "xoxb-abc",
          team: { id: "T123", name: "Acme" },
          bot_user_id: "Ubot",
          scope: "chat:write",
          authed_user: { id: "Uinstaller" },
        }),
      })) as unknown as typeof fetch,
    );

    const exch = await exchangeCode("the-code");
    expect(exch.access_token).toBe("xoxb-abc");
    expect(exch.team_id).toBe("T123");
    expect(exch.team_name).toBe("Acme");
    expect(exch.bot_user_id).toBe("Ubot");
    expect(exch.authed_user_id).toBe("Uinstaller");
  });

  it("falls back to empty string when authed_user absent", async () => {
    vi.stubEnv("SLACK_CLIENT_ID", "cid");
    vi.stubEnv("SLACK_CLIENT_SECRET", "csecret");
    vi.stubEnv("BACKEND_PUBLIC_URL", "https://api.example.com");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          ok: true,
          access_token: "xoxb-abc",
          team: { id: "T123", name: "Acme" },
          bot_user_id: "Ubot",
          scope: "chat:write",
        }),
      })) as unknown as typeof fetch,
    );

    const exch = await exchangeCode("the-code");
    expect(exch.authed_user_id).toBe("");
  });
});
