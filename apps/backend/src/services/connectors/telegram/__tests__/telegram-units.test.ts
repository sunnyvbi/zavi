import { describe, it, expect, afterEach } from "vitest";
import { makeLinkToken } from "@/services/connectors/bind-code";
import { stripBotMention, mentionsBot } from "../mention";
import { telegramEnabled, telegramEnv, verifyWebhookSecret } from "../adapter";
import { chunkText } from "@/services/tools/chunk-text";
import { AGENT_TRIGGERS } from "@/services/agents/types";
import { sourceToTrigger, isE2bOnlySource } from "@/services/agents/work-queue";

describe("telegram trigger plumbing", () => {
  it("admits 'telegram' to AGENT_TRIGGERS (mirror of the DB CHECK constraint)", () => {
    expect(AGENT_TRIGGERS).toContain("telegram");
  });
  it("is an interactive-resume trigger (approval-pause resumes back into the chat)", async () => {
    const { INTERACTIVE_RESUME_TRIGGERS } = await import("@/services/agents/approve-resume");
    expect(INTERACTIVE_RESUME_TRIGGERS.has("telegram")).toBe(true);
  });
  it("maps webhook_telegram source → 'telegram' trigger", () => {
    expect(sourceToTrigger("webhook_telegram")).toBe("telegram");
  });
  it("pins webhook_telegram to the e2b-only lane (connector-write egress)", () => {
    expect(isE2bOnlySource("webhook_telegram")).toBe(true);
  });
});

describe("telegram SAFE-INERT gate", () => {
  const saved = {
    token: process.env.TELEGRAM_BOT_TOKEN,
    secret: process.env.TELEGRAM_WEBHOOK_SECRET,
    username: process.env.TELEGRAM_BOT_USERNAME,
  };
  afterEach(() => {
    if (saved.token === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = saved.token;
    if (saved.secret === undefined) delete process.env.TELEGRAM_WEBHOOK_SECRET;
    else process.env.TELEGRAM_WEBHOOK_SECRET = saved.secret;
    if (saved.username === undefined) delete process.env.TELEGRAM_BOT_USERNAME;
    else process.env.TELEGRAM_BOT_USERNAME = saved.username;
  });

  it("is DISABLED when creds are unset (prod state until the bot is provisioned)", () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    expect(telegramEnabled()).toBe(false);
    expect(telegramEnv()).toBeNull();
  });

  it("is ENABLED only when BOTH creds are present", () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:abc";
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    expect(telegramEnabled()).toBe(false);
    process.env.TELEGRAM_WEBHOOK_SECRET = "s3cret";
    expect(telegramEnabled()).toBe(true);
    expect(telegramEnv()?.botToken).toBe("123:abc");
    expect(telegramEnv()?.botUsername).toBe("");
  });

  it("strips a leading @ from TELEGRAM_BOT_USERNAME", () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:abc";
    process.env.TELEGRAM_WEBHOOK_SECRET = "s3cret";
    process.env.TELEGRAM_BOT_USERNAME = "@zavi_bot";
    expect(telegramEnv()?.botUsername).toBe("zavi_bot");
  });

  it("verifyWebhookSecret: constant-time match, fail-closed on mismatch/missing/disabled", () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:abc";
    process.env.TELEGRAM_WEBHOOK_SECRET = "s3cret";
    expect(verifyWebhookSecret("s3cret")).toBe(true);
    expect(verifyWebhookSecret("wrong")).toBe(false);
    expect(verifyWebhookSecret("")).toBe(false);
    expect(verifyWebhookSecret(undefined)).toBe(false);
    delete process.env.TELEGRAM_BOT_TOKEN;
    expect(verifyWebhookSecret("s3cret")).toBe(false);
  });
});

describe("makeLinkToken (deep-link bind capability)", () => {
  it("fits Telegram's start-payload contract: 1-64 chars of [A-Za-z0-9_-]", () => {
    for (let i = 0; i < 20; i++) {
      const t = makeLinkToken();
      expect(t).toMatch(/^[A-Za-z0-9_-]{32}$/);
    }
  });
  it("is unique across mints (192-bit entropy sanity)", () => {
    const seen = new Set(Array.from({ length: 100 }, () => makeLinkToken()));
    expect(seen.size).toBe(100);
  });
});

describe("stripBotMention / mentionsBot", () => {
  const text = "@zavi_bot what's our CAC this week?";
  const entities = [{ type: "mention", offset: 0, length: 9 }];

  it("detects the bot mention via entity offsets", () => {
    expect(mentionsBot(text, entities, "zavi_bot")).toBe(true);
    expect(mentionsBot(text, entities, "other_bot")).toBe(false);
    expect(mentionsBot(text, [], "zavi_bot")).toBe(false);
  });

  it("strips the bot mention via the entities list", () => {
    expect(stripBotMention(text, entities, "zavi_bot")).toBe("what's our CAC this week?");
  });

  it("normalizes /command@bot to /command", () => {
    expect(stripBotMention("/status@zavi_bot please", [], "zavi_bot")).toBe("/status please");
  });

  it("returns empty string for non-string / empty input", () => {
    expect(stripBotMention(undefined, [], "zavi_bot")).toBe("");
    expect(stripBotMention("", [], "zavi_bot")).toBe("");
  });

  it("leaves other users' mentions intact", () => {
    const t = "@alice ping @zavi_bot do it";
    const es = [
      { type: "mention", offset: 0, length: 6 },
      { type: "mention", offset: 12, length: 9 },
    ];
    expect(stripBotMention(t, es, "zavi_bot")).toBe("@alice ping do it");
  });
});

describe("chunkText at the Telegram 4096 cap", () => {
  it("passes short text through as one chunk", () => {
    expect(chunkText("hello", 4096)).toEqual(["hello"]);
  });

  it("splits long text into ≤4096 chunks, preferring newline boundaries", () => {
    const line = "x".repeat(100);
    const text = Array.from({ length: 60 }, () => line).join("\n");
    const chunks = chunkText(text, 4096);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4096);
    expect(chunks.join("\n").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " "));
  });

  it("hard-splits a single overlong token rather than looping", () => {
    const chunks = chunkText("y".repeat(9000), 4096);
    expect(chunks.length).toBe(3);
    expect(chunks[0].length).toBe(4096);
  });

  it("never splits a surrogate pair across chunks", () => {
    const hasLoneSurrogate = (s: string) => {
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
          const next = s.charCodeAt(i + 1);
          if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
          i++;
        } else if (c >= 0xdc00 && c <= 0xdfff) {
          return true;
        }
      }
      return false;
    };
    for (let pad = 4090; pad <= 4100; pad++) {
      const text = "a".repeat(pad) + "\u{1F600}" + "b".repeat(4200);
      const chunks = chunkText(text, 4096);
      for (const c of chunks) {
        expect(c.length).toBeLessThanOrEqual(4096);
        expect(hasLoneSurrogate(c)).toBe(false);
      }
      expect(chunks.join("")).toBe(text);
    }
  });
});
