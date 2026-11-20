import { describe, it, expect, afterEach } from "vitest";
import { stripBotMention } from "../mention";
import { teamsEnabled, teamsEnv, getTeamsAdapter } from "../adapter";
import { AGENT_TRIGGERS } from "@/services/agents/types";
import { sourceToTrigger, isE2bOnlySource } from "@/services/agents/work-queue";

describe("teams trigger plumbing", () => {
  it("admits 'teams' to AGENT_TRIGGERS (mirror of the DB CHECK constraint)", () => {
    expect(AGENT_TRIGGERS).toContain("teams");
  });
  it("maps webhook_teams source → 'teams' trigger", () => {
    expect(sourceToTrigger("webhook_teams")).toBe("teams");
  });
  it("pins webhook_teams to the e2b-only lane (connector-write egress)", () => {
    expect(isE2bOnlySource("webhook_teams")).toBe(true);
  });
});

describe("teams SAFE-INERT gate", () => {
  const saved = {
    id: process.env.MICROSOFT_APP_ID,
    pw: process.env.MICROSOFT_APP_PASSWORD,
  };
  afterEach(() => {
    if (saved.id === undefined) delete process.env.MICROSOFT_APP_ID;
    else process.env.MICROSOFT_APP_ID = saved.id;
    if (saved.pw === undefined) delete process.env.MICROSOFT_APP_PASSWORD;
    else process.env.MICROSOFT_APP_PASSWORD = saved.pw;
  });

  it("is DISABLED when creds are unset (prod state until the Azure spike)", () => {
    delete process.env.MICROSOFT_APP_ID;
    delete process.env.MICROSOFT_APP_PASSWORD;
    expect(teamsEnabled()).toBe(false);
    expect(teamsEnv()).toBeNull();
  });

  it("is ENABLED only when BOTH creds are present", () => {
    process.env.MICROSOFT_APP_ID = "app-id-123";
    delete process.env.MICROSOFT_APP_PASSWORD;
    expect(teamsEnabled()).toBe(false);
    process.env.MICROSOFT_APP_PASSWORD = "secret";
    expect(teamsEnabled()).toBe(true);
    expect(teamsEnv()?.appId).toBe("app-id-123");
    expect(teamsEnv()?.appType).toBe("SingleTenant");
  });
});

describe("stripBotMention", () => {
  it("strips the bot mention via the entities list", () => {
    const text = "<at>Zavi</at> what's our CAC this week?";
    const entities = [{ type: "mention", text: "<at>Zavi</at>", mentioned: { id: "bot" } }];
    expect(stripBotMention(text, entities)).toBe("what's our CAC this week?");
  });
  it("strips residual <at> markup even without an entity (spoof-safe)", () => {
    expect(stripBotMention("hi <at>Zavi</at> there", [])).toBe("hi there");
  });
  it("returns empty string for non-string / empty input", () => {
    expect(stripBotMention(undefined, [])).toBe("");
    expect(stripBotMention("", [])).toBe("");
  });
  it("leaves a plain DM (no mention) intact", () => {
    expect(stripBotMention("draft a reply to the refund request", undefined)).toBe(
      "draft a reply to the refund request",
    );
  });
});

describe("teams adapter construction (zod 3/4 regression guard)", () => {
  const BOTBUILDER_MODULE = "botbuilder";

  async function loadBotbuilder(): Promise<Record<string, unknown> | null> {
    try {
      return (await import(BOTBUILDER_MODULE)) as Record<string, unknown>;
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code === "MODULE_NOT_FOUND" || /Cannot find (module|package)/i.test(msg)) {
        return null;
      }
      throw e;
    }
  }

  const saved = { ...process.env };
  afterEach(() => {
    for (const k of [
      "MICROSOFT_APP_ID",
      "MICROSOFT_APP_PASSWORD",
      "MICROSOFT_APP_TYPE",
      "MICROSOFT_APP_TENANT_ID",
    ]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("botbuilder module-evaluates (i.e. it resolved a zod that still has .nonstrict)", async () => {
    const bb = await loadBotbuilder();
    if (!bb) return;
    expect(typeof bb.CloudAdapter).toBe("function");
    expect(typeof bb.ConfigurationBotFrameworkAuthentication).toBe("function");
  });

  it("getTeamsAdapter() constructs instead of throwing (the prod 503 path)", async () => {
    if (!(await loadBotbuilder())) return;

    process.env.MICROSOFT_APP_ID = "00000000-0000-0000-0000-000000000001";
    process.env.MICROSOFT_APP_PASSWORD = "test-secret";
    process.env.MICROSOFT_APP_TYPE = "SingleTenant";
    process.env.MICROSOFT_APP_TENANT_ID = "00000000-0000-0000-0000-000000000002";

    await expect(getTeamsAdapter()).resolves.not.toBeNull();
  });
});
