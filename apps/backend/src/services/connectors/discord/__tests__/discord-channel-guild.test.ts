import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { discordChannelMembership, lookupDiscordChannelGuild } from "../adapter";

function reply(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));
}

describe("lookupDiscordChannelGuild", () => {
  beforeEach(() => {
    process.env.DISCORD_BOT_TOKEN = "t";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.DISCORD_BOT_TOKEN;
  });

  it("a guild channel: in when the guild matches, other when it does not", async () => {
    reply(200, { id: "123456", guild_id: "G1" });
    expect(await discordChannelMembership("123456", "G1")).toBe("in");
    expect(await discordChannelMembership("123456", "G2")).toBe("other");
  });

  it("unknown channel / no access / a DM: Discord answered, so other", async () => {
    for (const s of [400, 403, 404]) {
      reply(s, { message: "no" });
      expect(await discordChannelMembership("123456", "G1")).toBe("other");
    }
    reply(200, { id: "123456", type: 1 });
    expect(await discordChannelMembership("123456", "G1")).toBe("other");
  });

  it("5xx, 429, network: unknown (retryable), never other", async () => {
    for (const s of [500, 502, 429]) {
      reply(s, { message: "busy" });
      expect(await discordChannelMembership("123456", "G1")).toBe("unknown");
    }
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNRESET"); }));
    expect((await lookupDiscordChannelGuild("123456")).kind).toBe("unknown");
  });

  it("no bot token or a rejected token (401): bot_error, a real failure, not a blip", async () => {
    reply(401, { message: "401: Unauthorized" });
    expect(await discordChannelMembership("123456", "G1")).toBe("bot_error");
    delete process.env.DISCORD_BOT_TOKEN;
    expect(await discordChannelMembership("123456", "G1")).toBe("bot_error");
  });

  it("a malformed id never reaches Discord", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect(await discordChannelMembership("../guilds/1", "G1")).toBe("other");
    expect(f).not.toHaveBeenCalled();
  });
});
