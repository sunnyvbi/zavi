import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { rpcMock, fromMock, ingestEnqueueMock, callDiscordMock, state } = vi.hoisted(() => {
  const s = {
    tenantRow: null as { tenant_id: string; status: string } | null,
    consumeStatus: "ok" as string,
    consumeError: null as { message: string } | null,
    leaseOk: true,
    rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
    discordCalls: [] as Array<{ method: string; path: string; body?: Record<string, unknown> }>,
  };
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    s.rpcCalls.push({ fn, args });
    if (fn === "ingest_event") return { data: "ing-1", error: null };
    if (fn === "consume_discord_link_token")
      return s.consumeError
        ? { data: null, error: s.consumeError }
        : { data: s.consumeStatus, error: null };
    if (fn === "claim_discord_gateway_lease") return { data: s.leaseOk, error: null };
    return { data: null, error: null };
  });
  const from = vi.fn(() => ({
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        maybeSingle: vi.fn(async () => ({ data: s.tenantRow, error: null })),
      })),
    })),
    update: vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) })),
  }));
  return {
    rpcMock: rpc,
    fromMock: from,
    ingestEnqueueMock: vi.fn(
      async (
        _input: Record<string, unknown>,
      ): Promise<{ duplicate: boolean; ingested_event_id?: string; work_item_id?: string }> => ({
        duplicate: false,
        ingested_event_id: "ing-1",
        work_item_id: "w-1",
      }),
    ),
    callDiscordMock: vi.fn(async (method: string, path: string, body?: Record<string, unknown>) => {
      s.discordCalls.push({ method, path, body });
      return { ok: true, result: null };
    }),
    state: s,
  };
});

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ rpc: rpcMock, from: fromMock }),
}));
vi.mock("@/services/agents/work-queue", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/services/agents/work-queue")>();
  return { ...real, ingestAndEnqueueWorkItem: ingestEnqueueMock };
});
const fakeDiscord = vi.hoisted(() => {
  class Client {
    user = { id: "777" };
    intents: unknown;
    login = vi.fn(async () => "ok");
    destroy = vi.fn(async () => undefined);
    on = vi.fn();
    constructor(opts: { intents: unknown }) {
      this.intents = opts.intents;
      s.clients.push(this);
    }
  }
  const s = { clients: [] as Client[] };
  return {
    s,
    Client,
    GatewayIntentBits: { Guilds: 1, GuildMessages: 512, DirectMessages: 4096, MessageContent: 32768 },
    Partials: { Channel: 1 },
  };
});
vi.mock("discord.js", () => ({
  Client: fakeDiscord.Client,
  GatewayIntentBits: fakeDiscord.GatewayIntentBits,
  Partials: fakeDiscord.Partials,
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));

vi.mock("@/services/connectors/discord/adapter", async (importOriginal) => {
  const real = await importOriginal<
    typeof import("@/services/connectors/discord/adapter")
  >();
  return { ...real, callDiscord: callDiscordMock };
});

import {
  handleDiscordMessage,
  pickPostableChannelId,
  projectGatewayMessage,
  startDiscordGateway,
  stopDiscordGateway,
  __testing,
} from "../gateway";
import { discordEnabled, discordEnv, discordInstallUrl } from "../adapter";
import { chunkText } from "@/services/tools/chunk-text";
import { AGENT_TRIGGERS } from "@/services/agents/types";
import { sourceToTrigger, isE2bOnlySource } from "@/services/agents/work-queue";
import { INTERACTIVE_RESUME_TRIGGERS } from "@/services/agents/approve-resume";
import { isCanonicalContainer, isProbeContainer } from "@/services/agents/boot-role";

const TOKEN = "tok_ABCDEFGHIJKLMNOPQRSTUVWXYZ01";

function msg(over: Partial<Parameters<typeof handleDiscordMessage>[0]> = {}) {
  return {
    id: "9001",
    guild_id: "g-1",
    guild_name: "Acme HQ",
    channel_id: "c-1",
    content: "<@777> what's our CAC this week?",
    author: { id: "u-1", bot: false, username: "aryaan" },
    mentions_bot: true,
    mentions_bot_role: false,
    is_reply_to_bot: false,
    attachment_count: 0,
    ...over,
  };
}

describe("discord trigger plumbing", () => {
  it("admits 'discord' to AGENT_TRIGGERS (mirror of the DB CHECK constraint)", () => {
    expect(AGENT_TRIGGERS).toContain("discord");
  });
  it("maps webhook_discord source → 'discord' trigger", () => {
    expect(sourceToTrigger("webhook_discord")).toBe("discord");
  });
  it("pins webhook_discord to the e2b-only lane (connector-write egress)", () => {
    expect(isE2bOnlySource("webhook_discord")).toBe(true);
  });
  it("is an interactive-resume trigger", () => {
    expect(INTERACTIVE_RESUME_TRIGGERS.has("discord")).toBe(true);
  });
});

describe("gateway boot guard (PR #2231 review P1)", () => {
  const saved = process.env.PRAXIS_CONTAINER_ROLE;
  afterEach(() => {
    if (saved === undefined) delete process.env.PRAXIS_CONTAINER_ROLE;
    else process.env.PRAXIS_CONTAINER_ROLE = saved;
  });

  it("isCanonicalContainer is POSITIVE + fail-closed: only role=canonical qualifies", () => {
    process.env.PRAXIS_CONTAINER_ROLE = "canonical";
    expect(isCanonicalContainer()).toBe(true);
    process.env.PRAXIS_CONTAINER_ROLE = "probe";
    expect(isCanonicalContainer()).toBe(false);
    delete process.env.PRAXIS_CONTAINER_ROLE;
    expect(isCanonicalContainer()).toBe(false);
  });

  it("is NOT the negative probe check (the P1: !isProbeContainer() matches local dev)", () => {
    delete process.env.PRAXIS_CONTAINER_ROLE;
    expect(isProbeContainer()).toBe(false);
    expect(isCanonicalContainer()).toBe(false);
  });
});

describe("discord SAFE-INERT gate", () => {
  const saved = process.env.DISCORD_BOT_TOKEN;
  const savedClient = process.env.DISCORD_CLIENT_ID;
  afterEach(() => {
    if (saved === undefined) delete process.env.DISCORD_BOT_TOKEN;
    else process.env.DISCORD_BOT_TOKEN = saved;
    if (savedClient === undefined) delete process.env.DISCORD_CLIENT_ID;
    else process.env.DISCORD_CLIENT_ID = savedClient;
  });

  it("is DISABLED when the token is unset (prod state until provisioned)", () => {
    delete process.env.DISCORD_BOT_TOKEN;
    expect(discordEnabled()).toBe(false);
    expect(discordEnv()).toBeNull();
  });

  it("is ENABLED when the token is present", () => {
    process.env.DISCORD_BOT_TOKEN = "tok";
    expect(discordEnabled()).toBe(true);
    expect(discordEnv()?.botToken).toBe("tok");
  });

  it("install URL is null until DISCORD_CLIENT_ID lands, then a bot-scope authorize URL", () => {
    delete process.env.DISCORD_CLIENT_ID;
    expect(discordInstallUrl()).toBeNull();
    process.env.DISCORD_CLIENT_ID = "12345";
    expect(discordInstallUrl()).toContain("client_id=12345");
    expect(discordInstallUrl()).toContain("scope=bot");
  });
});

describe("handleDiscordMessage — intake pipeline", () => {
  beforeEach(() => {
    process.env.DISCORD_BOT_TOKEN = "tok";
    __testing.setStopping(false);
    state.tenantRow = { tenant_id: "t-1", status: "enabled" };
    state.consumeStatus = "ok";
    state.rpcCalls.length = 0;
    state.discordCalls.length = 0;
    ingestEnqueueMock.mockClear();
    callDiscordMock.mockClear();
  });
  afterEach(() => {
    delete process.env.DISCORD_BOT_TOKEN;
    __testing.setStopping(false);
  });

  it("bound guild @mention → ATOMIC ingest+enqueue with routing + sender identity, then 👀 ack", async () => {
    await handleDiscordMessage(msg());

    expect(ingestEnqueueMock).toHaveBeenCalledTimes(1);
    const arg = ingestEnqueueMock.mock.calls[0][0];
    expect(arg.tenant_id).toBe("t-1");
    expect(arg.provider).toBe("discord");
    expect(arg.external_event_id).toBe("9001");
    expect(arg.agent_slug).toBe("operator");
    expect(arg.source).toBe("webhook_discord");
    expect(arg.dedupe_key).toBe("discord:9001");
    const d = (arg.payload as { discord: Record<string, unknown> }).discord;
    expect(d.channel_id).toBe("c-1");
    expect(d.message_id).toBe("9001");
    expect(d.text).toBe("what's our CAC this week?");
    expect(d.from_user_id).toBe("u-1");
    expect(d.from_username).toBe("aryaan");

    expect(callDiscordMock).toHaveBeenCalledWith(
      "PUT",
      expect.stringContaining("/reactions/"),
    );
  });

  it("duplicate delivery → no ack (atomic RPC reported the dedupe)", async () => {
    ingestEnqueueMock.mockResolvedValueOnce({ duplicate: true });
    await handleDiscordMessage(msg());
    expect(callDiscordMock).not.toHaveBeenCalled();
  });

  it("intake failure → replies 'didn't go through' (no 👀 ack, never throws)", async () => {
    ingestEnqueueMock.mockRejectedValueOnce(new Error("fleet halted"));
    await expect(handleDiscordMessage(msg())).resolves.toBeUndefined();
    expect(state.discordCalls.find((c) => c.method === "PUT")).toBeUndefined();
    const reply = state.discordCalls.find((c) => c.method === "POST");
    expect(reply?.path).toBe("/channels/c-1/messages");
    expect(String(reply?.body?.content)).toMatch(/didn't go through/);
    expect((reply?.body?.message_reference as { message_id: string }).message_id).toBe("9001");
  });

  it("unbound guild → fail closed (no ingest, no enqueue)", async () => {
    state.tenantRow = null;
    await handleDiscordMessage(msg());
    expect(state.rpcCalls.find((c) => c.fn === "ingest_event")).toBeUndefined();
    expect(ingestEnqueueMock).not.toHaveBeenCalled();
  });

  it("draining (stopDiscordGateway) → new events are not admitted", async () => {
    __testing.setStopping(true);
    await handleDiscordMessage(msg());
    expect(ingestEnqueueMock).not.toHaveBeenCalled();
    expect(state.rpcCalls.length).toBe(0);
  });

  it("bot-authored messages never wake the fleet (self-trigger guard)", async () => {
    await handleDiscordMessage(msg({ author: { id: "u-2", bot: true } }));
    expect(ingestEnqueueMock).not.toHaveBeenCalled();
  });

  it("non-mention channel chatter is ignored (Slack app_mention parity)", async () => {
    await handleDiscordMessage(msg({ mentions_bot: false, is_reply_to_bot: false }));
    expect(ingestEnqueueMock).not.toHaveBeenCalled();
  });

  it("an @mention of the bot's ROLE is answered with how to pick the app, never run", async () => {
    const roleMention = msg({ channel_id: "c-role", content: "", mentions_bot: false, mentions_bot_role: true });
    await handleDiscordMessage(roleMention);
    await handleDiscordMessage(roleMention);
    expect(ingestEnqueueMock).not.toHaveBeenCalled();
    const replies = state.discordCalls.filter((c) => c.method === "POST");
    expect(replies).toHaveLength(1);
    expect(replies[0].path).toBe("/channels/c-role/messages");
    expect(String(replies[0].body?.content)).toMatch(/APP badge/);
  });

  it("a DM is answered with guidance, never run (no ingest, no enqueue)", async () => {
    await handleDiscordMessage(msg({ guild_id: "", channel_id: "dm-1", mentions_bot: false }));
    expect(ingestEnqueueMock).not.toHaveBeenCalled();
    const reply = state.discordCalls.find((c) => c.method === "POST");
    expect(reply?.path).toBe("/channels/dm-1/messages");
    expect(String(reply?.body?.content)).toMatch(/inside a Discord server/);
  });

  it("DMs (no guild) are unsupported in v1", async () => {
    await handleDiscordMessage(msg({ guild_id: "" }));
    expect(ingestEnqueueMock).not.toHaveBeenCalled();
  });

  it("attachment-only mention → 'can't read images' reply, no ingest, no run", async () => {
    await handleDiscordMessage(msg({ content: "<@777>", attachment_count: 1 }));
    expect(ingestEnqueueMock).not.toHaveBeenCalled();
    expect(state.rpcCalls.find((c) => c.fn === "ingest_event")).toBeUndefined();
    const reply = state.discordCalls.find((c) => c.method === "POST");
    expect(reply?.path).toBe("/channels/c-1/messages");
    expect(String(reply?.body?.content)).toMatch(/can't read images/);
    expect((reply?.body?.message_reference as { message_id: string }).message_id).toBe("9001");
  });

  it("bare mention (empty task after strip) → no ingest, no run (Telegram/WhatsApp posture)", async () => {
    await handleDiscordMessage(msg({ content: "<@777>" }));
    expect(state.rpcCalls.find((c) => c.fn === "ingest_event")).toBeUndefined();
    expect(ingestEnqueueMock).not.toHaveBeenCalled();
    expect(callDiscordMock).not.toHaveBeenCalled();
  });
});

describe("handleDiscordMessage — '@Zavi connect <token>' bind flow", () => {
  beforeEach(() => {
    process.env.DISCORD_BOT_TOKEN = "tok";
    __testing.setStopping(false);
    state.tenantRow = null;
    state.consumeStatus = "ok";
    state.rpcCalls.length = 0;
    state.discordCalls.length = 0;
    ingestEnqueueMock.mockClear();
    callDiscordMock.mockClear();
  });
  afterEach(() => {
    delete process.env.DISCORD_BOT_TOKEN;
  });

  it("consumes the token with guild + Discord poster identity, replies Connected, never runs", async () => {
    await handleDiscordMessage(msg({ content: `<@777> connect ${TOKEN}` }));

    const consume = state.rpcCalls.find((c) => c.fn === "consume_discord_link_token");
    expect(consume).toBeTruthy();
    expect(consume?.args.p_token).toBe(TOKEN);
    expect(consume?.args.p_guild_id).toBe("g-1");
    expect(consume?.args.p_guild_name).toBe("Acme HQ");
    expect(consume?.args.p_discord_user_id).toBe("u-1");
    expect(consume?.args.p_discord_username).toBe("aryaan");

    const reply = state.discordCalls.find((c) => c.method === "POST");
    expect(String(reply?.body?.content)).toContain("Connected");
    expect(ingestEnqueueMock).not.toHaveBeenCalled();
  });

  it("explicit refusal statuses reply distinctly (no silent guild swap — PR #2231 P2)", async () => {
    state.consumeStatus = "tenant_already_bound";
    await handleDiscordMessage(msg({ content: `<@777> connect ${TOKEN}` }));
    const reply = state.discordCalls.find((c) => c.method === "POST");
    expect(String(reply?.body?.content)).toMatch(/already connected to a different Discord server/i);

    state.discordCalls.length = 0;
    state.consumeStatus = "invalid_or_expired";
    await handleDiscordMessage(msg({ content: `<@777> connect ${TOKEN}` }));
    const reply2 = state.discordCalls.find((c) => c.method === "POST");
    expect(String(reply2?.body?.content)).toMatch(/invalid or has expired/i);
  });

  it("a failed consume call is answered, not swallowed", async () => {
    state.consumeError = { message: "connection reset" };
    try {
      await handleDiscordMessage(msg({ content: `<@777> connect ${TOKEN}` }));
    } finally {
      state.consumeError = null;
    }
    const reply = state.discordCalls.find((c) => c.method === "POST");
    expect(reply?.path).toBe("/channels/c-1/messages");
    expect(String(reply?.body?.content)).toMatch(/Couldn't confirm the connection just now/);
    expect(ingestEnqueueMock).not.toHaveBeenCalled();
  });

  it("a connect attempt without a plausible token falls through to normal gating (no consume)", async () => {
    state.tenantRow = { tenant_id: "t-1", status: "enabled" };
    await handleDiscordMessage(msg({ content: "<@777> connect the CRM to the warehouse" }));
    expect(state.rpcCalls.find((c) => c.fn === "consume_discord_link_token")).toBeUndefined();
    expect(ingestEnqueueMock).toHaveBeenCalledTimes(1);
  });
});

describe("projectGatewayMessage — which @Zavi was mentioned", () => {
  const raw = (users: string[], roles: string[]) => ({
    id: "1",
    guildId: "g-1",
    channelId: "c-1",
    content: "",
    author: { id: "u-1", bot: false },
    guild: { roles: { botRoleFor: (id: string) => (id === "777" ? { id: "r-zavi" } : null) } },
    mentions: { users: new Set(users), roles: new Set(roles) },
  });

  it("the app mention sets mentions_bot", () => {
    const m = projectGatewayMessage(raw(["777"], []), "777");
    expect(m.mentions_bot).toBe(true);
    expect(m.mentions_bot_role).toBe(false);
  });

  it("the bot's managed role sets mentions_bot_role, not mentions_bot", () => {
    const m = projectGatewayMessage(raw([], ["r-zavi"]), "777");
    expect(m.mentions_bot).toBe(false);
    expect(m.mentions_bot_role).toBe(true);
  });

  it("any other role is neither", () => {
    const m = projectGatewayMessage(raw([], ["r-mods"]), "777");
    expect(m.mentions_bot_role).toBe(false);
  });
});

describe("pickPostableChannelId (system-channel fallback — PR #2231 P2)", () => {
  const perms = (ok: boolean) => ({ has: () => ok });
  const ch = (id: string, ok = true, type = 0) => ({
    id,
    type,
    permissionsFor: () => perms(ok),
  });
  const cacheOf = (arr: any[]) => ({
    get: (id: string) => arr.find((c) => c.id === id),
    find: (fn: (c: any) => boolean) => arr.find(fn),
  });

  it("prefers the system channel when postable", () => {
    const guild = {
      systemChannelId: "sys",
      members: { me: {} },
      channels: { cache: cacheOf([ch("sys"), ch("general")]) },
    };
    expect(pickPostableChannelId(guild)).toBe("sys");
  });

  it("falls back to the first postable text channel when the system channel is unpostable", () => {
    const guild = {
      systemChannelId: "sys",
      members: { me: {} },
      channels: { cache: cacheOf([ch("sys", false), ch("voice", true, 2), ch("general")]) },
    };
    expect(pickPostableChannelId(guild)).toBe("general");
  });

  it("returns '' when nothing is postable (install proceeds silently; Settings carries instructions)", () => {
    const guild = {
      systemChannelId: "",
      members: { me: {} },
      channels: { cache: cacheOf([ch("locked", false)]) },
    };
    expect(pickPostableChannelId(guild)).toBe("");
  });
});

describe("gateway start/stop — singleton lease discipline (PR #2231 review P1)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.DISCORD_BOT_TOKEN = "tok";
    state.leaseOk = true;
    state.rpcCalls.length = 0;
    fakeDiscord.s.clients.length = 0;
  });
  afterEach(async () => {
    await stopDiscordGateway();
    vi.useRealTimers();
    delete process.env.DISCORD_BOT_TOKEN;
  });

  it("SAFE-INERT: no token -> never claims, never connects", async () => {
    delete process.env.DISCORD_BOT_TOKEN;
    expect(await startDiscordGateway()).toEqual({ started: false });
    expect(state.rpcCalls.length).toBe(0);
    expect(fakeDiscord.s.clients.length).toBe(0);
  });

  it("claims the lease BEFORE opening a socket; logs in with Guilds+GuildMessages+DirectMessages only (no MessageContent)", async () => {
    expect(await startDiscordGateway()).toEqual({ started: true });
    const claim = state.rpcCalls.find((c) => c.fn === "claim_discord_gateway_lease");
    expect(claim?.args.p_holder).toBe(__testing.holder());
    expect(fakeDiscord.s.clients.length).toBe(1);
    const client = fakeDiscord.s.clients[0];
    expect(client.login).toHaveBeenCalledWith("tok");
    expect(client.intents).toEqual([1, 512, 4096]);
    expect(await startDiscordGateway()).toEqual({ started: true });
    expect(fakeDiscord.s.clients.length).toBe(1);
  });

  it("lease held elsewhere (blue-green predecessor) -> no socket; connects once the lease frees up", async () => {
    state.leaseOk = false;
    expect(await startDiscordGateway()).toEqual({ started: false });
    expect(fakeDiscord.s.clients.length).toBe(0);
    state.leaseOk = true;
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.waitFor(() => expect(fakeDiscord.s.clients.length).toBe(1));
    expect(fakeDiscord.s.clients[0].login).toHaveBeenCalledWith("tok");
  });

  it("renewal: losing the lease disconnects THIS session (never two live sessions)", async () => {
    await startDiscordGateway();
    const client = fakeDiscord.s.clients[0];
    state.leaseOk = false;
    await vi.advanceTimersByTimeAsync(20_000);
    await vi.waitFor(() => expect(client.destroy).toHaveBeenCalledTimes(1));
  });

  it("stop (SIGTERM drain): destroys the socket, releases the lease by holder, admits no more events", async () => {
    await startDiscordGateway();
    const client = fakeDiscord.s.clients[0];
    await stopDiscordGateway();
    expect(client.destroy).toHaveBeenCalledTimes(1);
    const release = state.rpcCalls.find((c) => c.fn === "release_discord_gateway_lease");
    expect(release?.args.p_holder).toBe(__testing.holder());
    state.tenantRow = { tenant_id: "t-1", status: "enabled" };
    ingestEnqueueMock.mockClear();
    await handleDiscordMessage(msg());
    expect(ingestEnqueueMock).not.toHaveBeenCalled();
  });
});

describe("chunkText at the Discord 2000 cap", () => {
  it("never splits a surrogate pair (emoji) at the hard-cut boundary", () => {
    const rocket = "\uD83D\uDE80";
    const text = "z".repeat(1999) + rocket + "tail";
    const chunks = chunkText(text, 2000);
    expect(chunks[0]).toBe("z".repeat(1999));
    expect(chunks[1].startsWith(rocket)).toBe(true);
    for (const c of chunks) expect(c).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
  });
  it("passes short text through as one chunk", () => {
    expect(chunkText("hello", 2000)).toEqual(["hello"]);
  });
  it("splits long text into ≤2000 chunks on newline boundaries", () => {
    const line = "x".repeat(90);
    const text = Array.from({ length: 40 }, () => line).join("\n");
    const chunks = chunkText(text, 2000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2000);
  });
  it("hard-splits a single overlong token", () => {
    const chunks = chunkText("y".repeat(4500), 2000);
    expect(chunks.length).toBe(3);
    expect(chunks[0].length).toBe(2000);
  });
});
