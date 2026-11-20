
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  showInChat: vi.fn(),
  ownImage: vi.fn(),
  maybeSingle: vi.fn(),
  callStreamableTool: vi.fn(),
  tenantScopedFor: vi.fn(),
  record: vi.fn(),
  switchedChannelForRun: vi.fn(),
  autostart: vi.fn(),
  chat: vi.fn(),
}));

vi.mock("@/services/chat-images/sign-own-image", () => ({ checkOwnImageForVendor: mocks.ownImage }));
const look = vi.hoisted(() => ({ lookAtPresenterPhoto: vi.fn() }));
vi.mock("@/services/video-studio/photo-look", () => look);
vi.mock("../chat-card", async (orig) => ({
  ...(await orig<typeof import("../chat-card")>()),
  showVideoCardInChat: mocks.showInChat,
}));
vi.mock("../starter-autostart", () => ({
  autostartStarterVideo: mocks.autostart,
  autostartChatVideo: mocks.chat,
}));

vi.mock("@/services/channels/exec-actions", () => ({
  recordChannelExecAction: mocks.record,
}));
vi.mock("@/services/channels/channel-actions", () => ({
  switchedChannelForRun: mocks.switchedChannelForRun,
}));

vi.mock("@/services/tenant-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/tenant-client")>()),
  asTenantId: (t: string) => t,
  tenantClient: (t: string) => {
    mocks.tenantScopedFor(t);
    return {
      from: () => ({
        select: () => ({
          eq: () => ({ eq: () => ({ maybeSingle: mocks.maybeSingle }) }),
        }),
      }),
    };
  },
}));
vi.mock("@/services/mcp/streamable-client", () => ({
  callStreamableTool: mocks.callStreamableTool,
}));

import { listGeneratedVideoTools, callGeneratedVideoTool } from "@/services/mcp/internal/generated-video";
import { generatedVideoProposeTool, GENERATED_VIDEO_RENDER_CLASS, renderIntakeFor, type VideoProposeInput } from "../propose_video";

const generatedVideoInput = (i: unknown) => i as VideoProposeInput;

const TENANT = "11111111-1111-1111-1111-111111111111";
const RUN = "22222222-2222-2222-2222-222222222222";
const ctx = (extra: Record<string, unknown> = {}) =>
  ({ tenant_id: TENANT, log: () => {}, run_id: RUN, ...extra }) as never;

const VALID_INPUT = {
  format: "product_demo" as const,
  hook: "Setup took me four minutes, and that was the whole job.",
  script:
    "Setup took me four minutes, and that was the whole job. You connect the calendar, pick the shifts, and the rota fills itself. No spreadsheet, no group chat at midnight. That is the hour a week you get back.",
  scene: "A generic AI presenter in her thirties at a kitchen table, plain jumper, morning light.",
  presenter_gender: "female" as const,
  caption: "Four minutes to set up. An hour a week back.",
  objection: "Three of the last ten G2 reviews say setup looked slow; this tests a hook that answers it.",
};

beforeEach(() => {
  mocks.maybeSingle.mockReset();
  mocks.callStreamableTool.mockReset();
  mocks.tenantScopedFor.mockReset();
  mocks.record.mockReset();
  mocks.switchedChannelForRun.mockReset();
  mocks.autostart.mockReset();
  mocks.autostart.mockResolvedValue("not_starter");
  mocks.chat.mockReset();
  mocks.chat.mockResolvedValue("not_chat");
});

describe("generated_video facade", () => {
  it("offers the channel no account check, so it never claims a video account is missing", async () => {
    const names = listGeneratedVideoTools().map((t) => t.tool_name);
    expect(names).toEqual(["propose", "animate"]);

    const out = await callGeneratedVideoTool({ tenant_id: TENANT, run_id: RUN }, "account_status", {});
    expect(out.ok).toBe(false);
    expect(JSON.parse(out.content)).toMatchObject({ error: "tool_unknown" });
    expect(mocks.maybeSingle).not.toHaveBeenCalled();
    expect(mocks.callStreamableTool).not.toHaveBeenCalled();
  });
});

describe("generated_video_propose", () => {
  it("keeps the agent's voice when it matches the presenter, and replaces one that does not", async () => {
    mocks.switchedChannelForRun.mockResolvedValue("generated_video");
    mocks.record.mockResolvedValue({ id: "action-1", replayed: false });

    await generatedVideoProposeTool.execute(ctx(), { ...VALID_INPUT, voice: "Laura" });
    expect(mocks.record.mock.calls[0][0].execPayload.intake.voice).toBe("Laura");

    mocks.record.mockClear();
    await generatedVideoProposeTool.execute(ctx(), { ...VALID_INPUT, voice: "Brian" });
    expect(mocks.record.mock.calls[0][0].execPayload.intake.voice).toBe("Jessica");

    mocks.record.mockClear();
    await generatedVideoProposeTool.execute(ctx(), { ...VALID_INPUT, presenter_gender: "male", voice: "nobody" });
    expect(mocks.record.mock.calls[0][0].execPayload.intake.voice).toBe("Chris");
  });

  it("refuses a card with no presenter gender, because the portrait and the voice are both made from it", async () => {
    mocks.switchedChannelForRun.mockResolvedValue("generated_video");
    const { presenter_gender: _omit, ...noPresenter } = VALID_INPUT;
    await expect(generatedVideoProposeTool.execute(ctx(), noPresenter)).rejects.toThrow();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("writes exactly one approvable card with its credit cost, and renders nothing", async () => {
    mocks.switchedChannelForRun.mockResolvedValue("generated_video");
    mocks.record.mockResolvedValue({ id: "action-1", replayed: false });

    const out = (await generatedVideoProposeTool.execute(ctx(), VALID_INPUT)) as Record<string, unknown>;

    expect(mocks.record).toHaveBeenCalledTimes(1);
    const arg = mocks.record.mock.calls[0][0];
    expect(arg).toMatchObject({
      tenantId: TENANT,
      runId: RUN,
      execClass: GENERATED_VIDEO_RENDER_CLASS,
      actionType: "video_post",
    });
    expect(arg.execPayload.intake).toMatchObject({ intent: "talking_head", aspect_ratio: "9:16", script: VALID_INPUT.script });
    expect(arg.execPayload.intake).toMatchObject({ prompt: VALID_INPUT.scene, presenter_gender: "female", voice: "Jessica" });
    expect(arg.execPayload).not.toHaveProperty("cost_credits");
    expect(arg.body.cost_credits).toBe(860);
    expect(arg.body.step.body).toContain("It costs about 860 credits");
    expect(arg.body.step.body).toContain("Press Make video to make this");
    expect(arg.body.step.body).not.toMatch(/approve/i);
    expect(String(out.note)).toContain("press Make video on it");
    expect(String(out.note)).toContain("Suggested ads on the AI UGC Videos channel's Overview tab");
    expect(String(out.note)).not.toMatch(/approve/i);
    expect(JSON.stringify(arg.body.exact_change)).toContain("860 credits, charged only when the video arrives");
    expect(out).toMatchObject({ action_id: "action-1", proposed: true, rendered: false });
    expect(mocks.callStreamableTool).not.toHaveBeenCalled();
    expect(mocks.maybeSingle).not.toHaveBeenCalled();
  });

  it("files the card on the YouTube channel for a run handed off for YouTube, and says where to approve it", async () => {
    mocks.switchedChannelForRun.mockResolvedValue("youtube_organic");
    mocks.record.mockResolvedValue({ id: "action-yt", replayed: false });

    const out = (await generatedVideoProposeTool.execute(ctx(), VALID_INPUT)) as Record<string, unknown>;

    expect(mocks.record.mock.calls[0][0]).toMatchObject({ channelSlug: "youtube_organic", execClass: GENERATED_VIDEO_RENDER_CLASS });
    expect(out).toMatchObject({ action_id: "action-yt", proposed: true });
    expect(out.note).toMatch(/YouTube channel page/);
    expect(out.note).toMatch(/not in Needs you now/);
    expect(out.note).toMatch(/approve it there/);
    expect(mocks.record.mock.calls[0][0].body.step.body).toContain("Press Approve to make this");
  });

  it("refuses a run that is not an AI UGC Videos channel run, writing nothing", async () => {
    mocks.switchedChannelForRun.mockResolvedValue("ugc");
    await expect(generatedVideoProposeTool.execute(ctx(), VALID_INPUT)).rejects.toMatchObject({
      code: "generated_video_propose_wrong_run",
    });
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("refuses a chat turn with no run id", async () => {
    await expect(generatedVideoProposeTool.execute(ctx({ run_id: undefined }), VALID_INPUT)).rejects.toMatchObject({
      code: "generated_video_propose_wrong_run",
    });
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("writes nothing on a shadow / draft run", async () => {
    mocks.switchedChannelForRun.mockResolvedValue("generated_video");
    const out = (await generatedVideoProposeTool.execute(ctx({ writes_suppressed: true }), VALID_INPUT)) as Record<string, unknown>;
    expect(out).toMatchObject({ proposed: false });
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("refuses a presenter speaking as a customer (no testimonial)", async () => {
    mocks.switchedChannelForRun.mockResolvedValue("generated_video");
    await expect(
      generatedVideoProposeTool.execute(ctx(), {
        ...VALID_INPUT,
        script: "I bought this last month and honestly it changed my life, the setup took four minutes and the rota fills itself every single week now.",
      }),
    ).rejects.toMatchObject({ code: "generated_video_customer_voice" });
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it.each([
    { script: "Here is what our customers are saying: setup takes four minutes, you connect the calendar, pick the shifts, and the rota fills itself with no spreadsheet at all." },
    { hook: "Managers rate it 4.9 stars on Google, here is why." },
    { scene: "A happy customer in her thirties at a kitchen table, plain jumper, morning light." },
  ])("refuses a presenter framed as a customer endorsement: %o", async (over) => {
    mocks.switchedChannelForRun.mockResolvedValue("generated_video");
    await expect(generatedVideoProposeTool.execute(ctx(), { ...VALID_INPUT, ...over })).rejects.toMatchObject({ code: "generated_video_testimonial" });
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("has no testimonial or review format to propose", () => {
    const schema = generatedVideoProposeTool.input_schema as unknown as { safeParse: (v: unknown) => { success: boolean } };
    expect(schema.safeParse({ ...VALID_INPUT, format: "testimonial" }).success).toBe(false);
    expect(schema.safeParse({ ...VALID_INPUT, format: "review" }).success).toBe(false);
  });

  it("rejects a script far from 20 seconds before anything is written", async () => {
    mocks.switchedChannelForRun.mockResolvedValue("generated_video");
    await expect(generatedVideoProposeTool.execute(ctx(), { ...VALID_INPUT, script: "Too short." })).rejects.toBeTruthy();
    expect(mocks.record).not.toHaveBeenCalled();
  });
});

describe("generated_video_propose: the five starter formats", () => {
  it.each([
    ["product_demo", "Product demo"],
    ["explainer", "Explainer"],
    ["hook", "Hook"],
    ["behind_the_scenes", "Behind the scenes"],
    ["offer", "Offer"],
  ] as const)("writes a %s card titled %s", async (format, label) => {
    mocks.switchedChannelForRun.mockResolvedValue("generated_video");
    mocks.record.mockResolvedValue({ id: `action-${format}`, replayed: false });

    const out = (await generatedVideoProposeTool.execute(ctx(), { ...VALID_INPUT, format })) as Record<string, unknown>;

    expect(out).toMatchObject({ action_id: `action-${format}`, proposed: true, rendered: false });
    const arg = mocks.record.mock.calls[0][0];
    expect(arg.title.startsWith(`${label}: `)).toBe(true);
    expect(arg.execPayload.format).toBe(format);
    expect(arg.body.exact_change.rows[0].after.startsWith(`${label}, about 15 seconds`)).toBe(true);
  });

  it("still refuses a testimonial format", async () => {
    mocks.switchedChannelForRun.mockResolvedValue("generated_video");
    await expect(generatedVideoProposeTool.execute(ctx(), { ...VALID_INPUT, format: "testimonial" })).rejects.toThrow();
    expect(mocks.record).not.toHaveBeenCalled();
  });
});

describe("generated_video_propose on a Start the AI run", () => {
  it("starts the video itself and tells the model not to ask for approval", async () => {
    mocks.switchedChannelForRun.mockResolvedValue("generated_video");
    mocks.record.mockResolvedValue({ id: "action-starter", replayed: false });
    mocks.autostart.mockResolvedValue("started");

    const out = (await generatedVideoProposeTool.execute(ctx(), VALID_INPUT)) as Record<string, unknown>;

    expect(mocks.autostart).toHaveBeenCalledWith(TENANT, RUN, { actionId: "action-starter", kept: false });
    expect(out).toMatchObject({ action_id: "action-starter", starter: true, rendered: false });
    expect(String(out.note)).toContain("Do not ask the founder to press Make video on it");
    expect(String(out.note)).not.toContain("Start the AI");
  });

  it("an ordinary run still leaves the card for the founder's Approve", async () => {
    mocks.switchedChannelForRun.mockResolvedValue("generated_video");
    mocks.record.mockResolvedValue({ id: "action-plain", replayed: false });

    const out = (await generatedVideoProposeTool.execute(ctx(), VALID_INPUT)) as Record<string, unknown>;

    expect(out).not.toHaveProperty("starter");
    expect(String(out.note)).toContain("only after they press Make video on it");
  });
});

describe("generated_video_propose on a Start the AI run, past the cap or onto a kept card", () => {
  it("tells the autostart the card was an existing one the dedupe kept", async () => {
    mocks.switchedChannelForRun.mockResolvedValue("generated_video");
    mocks.record.mockResolvedValue({ id: "action-old", replayed: false, kept: true });
    mocks.autostart.mockResolvedValue("not_new");

    const out = (await generatedVideoProposeTool.execute(ctx(), VALID_INPUT)) as Record<string, unknown>;

    expect(mocks.autostart).toHaveBeenCalledWith(TENANT, RUN, { actionId: "action-old", kept: true });
    expect(out).not.toHaveProperty("starter");
    expect(String(out.note)).toContain("only after they press Make video on it");
  });

  it("a capped second starter card waits for the founder's Approve and says nothing was spent", async () => {
    mocks.switchedChannelForRun.mockResolvedValue("generated_video");
    mocks.record.mockResolvedValue({ id: "action-two", replayed: false });
    mocks.autostart.mockResolvedValue("capped");

    const out = (await generatedVideoProposeTool.execute(ctx(), VALID_INPUT)) as Record<string, unknown>;

    expect(out).toMatchObject({ action_id: "action-two", proposed: true, rendered: false, starter: true });
    expect(String(out.note)).toContain("waits for the founder to press Make video");
    expect(String(out.note)).not.toMatch(/approve/i);
    expect(String(out.note)).toContain("NOTHING has been made");
    expect(String(out.note)).not.toContain("being made now");
  });
});

describe("generated_video_propose: alt hooks", () => {
  const ALT_A = "Your rota, filled before lunch.";
  const ALT_B = "No spreadsheet, no group chat at midnight.";
  const VOICE = "I bought this last month and it changed my life.";
  const TESTIMONIAL = "Managers rate it 4.9 stars on Google, here is why.";

  const propose = async (alt_hooks: unknown) => {
    mocks.switchedChannelForRun.mockResolvedValue("generated_video");
    mocks.record.mockResolvedValue({ id: "action-alts", replayed: false });
    await generatedVideoProposeTool.execute(ctx(), { ...VALID_INPUT, alt_hooks });
    return mocks.record.mock.calls[0][0].body.hooks as string[];
  };

  it("puts the hook first and the alts after it, in the order given", async () => {
    expect(await propose([ALT_A, ALT_B])).toEqual([VALID_INPUT.hook, ALT_A, ALT_B]);
    mocks.record.mockClear();
    expect(await propose([ALT_B, ALT_A])).toEqual([VALID_INPUT.hook, ALT_B, ALT_A]);
  });

  it("shows only the hook when there are no alts", async () => {
    expect(await propose(undefined)).toEqual([VALID_INPUT.hook]);
  });

  it("drops a blank alt and one that repeats the hook with surrounding whitespace", async () => {
    expect(await propose(["   ", ALT_A])).toEqual([VALID_INPUT.hook, ALT_A]);
    mocks.record.mockClear();
    expect(await propose([`  ${VALID_INPUT.hook}  `, ALT_B])).toEqual([VALID_INPUT.hook, ALT_B]);
  });

  it("drops a case-only repeat of the hook, a repeated alt, and trims what it keeps", async () => {
    expect(await propose([VALID_INPUT.hook.toUpperCase(), `  ${ALT_A}  `])).toEqual([VALID_INPUT.hook, ALT_A]);
    mocks.record.mockClear();
    expect(await propose([ALT_A, ALT_A.toLowerCase()])).toEqual([VALID_INPUT.hook, ALT_A]);
  });

  it.each([
    [[ALT_A, ALT_B, "A third first line."]],
    [[""]],
    [["x".repeat(201)]],
    [[ALT_A, 7]],
    ["one string"],
  ])("rejects alt_hooks %o before anything is written", async (bad) => {
    mocks.switchedChannelForRun.mockResolvedValue("generated_video");
    await expect(generatedVideoProposeTool.execute(ctx(), { ...VALID_INPUT, alt_hooks: bad })).rejects.toThrow();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("writes the card when both alts are clean, so the hook, script and scene are not what refuses", async () => {
    mocks.switchedChannelForRun.mockResolvedValue("generated_video");
    mocks.record.mockResolvedValue({ id: "action-clean", replayed: false });
    await expect(generatedVideoProposeTool.execute(ctx(), { ...VALID_INPUT, alt_hooks: [ALT_A, ALT_B] })).resolves.toMatchObject({ proposed: true });
  });

  it.each([
    [[VOICE, ALT_A], "generated_video_customer_voice"],
    [[ALT_A, VOICE], "generated_video_customer_voice"],
    [[TESTIMONIAL, ALT_A], "generated_video_testimonial"],
    [[ALT_A, TESTIMONIAL], "generated_video_testimonial"],
  ] as const)("refuses a card whose only offending line is an alt hook: %o", async (alts, code) => {
    mocks.switchedChannelForRun.mockResolvedValue("generated_video");
    await expect(generatedVideoProposeTool.execute(ctx(), { ...VALID_INPUT, alt_hooks: [...alts] })).rejects.toMatchObject({ code });
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.autostart).not.toHaveBeenCalled();
  });
});

describe("a chat or Suggested-ads card that casts the presenter as a customer is never filed", () => {
  it.each([
    { scene: "The presenter poses as a regular customer at a Cakely counter, cardigan, afternoon light." },
    { scene: "A presenter who acts as a happy client, kitchen table, morning light." },
    { script: "I've been ordering Cakely cakes for months as a regular customer and every one has been perfect for our family birthdays, honestly." },
    { hook: "As a loyal customer, here is what I order every week." },
  ])("refuses %o before the card is written or a video is autostarted", async (over) => {
    mocks.switchedChannelForRun.mockResolvedValue("generated_video");
    await expect(generatedVideoProposeTool.execute(ctx(), { ...VALID_INPUT, ...over })).rejects.toMatchObject({ code: "generated_video_customer_voice" });
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.autostart).not.toHaveBeenCalled();
  });

  it("still files a card whose presenter is the founder speaking about the bakery", async () => {
    mocks.switchedChannelForRun.mockResolvedValue("generated_video");
    mocks.record.mockResolvedValue({ id: "action-founder", replayed: false });
    await expect(
      generatedVideoProposeTool.execute(ctx(), { ...VALID_INPUT, scene: "A presenter who says she is the founder and bakes every cake, flour on her apron, bakery kitchen." }),
    ).resolves.toMatchObject({ proposed: true });
  });
});

describe("generated_video_propose asked for in chat", () => {
  const FOUNDER = "33333333-3333-4333-8333-333333333333";
  const founderCtx = (extra: Record<string, unknown> = {}) =>
    ctx({ founder_chat_order: true, founder_order_unverified: false, actor_user_id: FOUNDER, ...extra });

  beforeEach(() => {
    mocks.showInChat.mockReset().mockResolvedValue("not_chat");
  });

  it("a founder's photo of a person becomes the presenter on the card and in the render", async () => {
    mocks.switchedChannelForRun.mockResolvedValue("generated_video");
    mocks.record.mockResolvedValue({ id: "action-photo", replayed: false });
    mocks.ownImage.mockReset().mockResolvedValue(undefined);
    const input = { ...VALID_INPUT, portrait_path: `${TENANT}/me.png` };
    await generatedVideoProposeTool.execute(founderCtx(), input);
    expect(mocks.ownImage).toHaveBeenCalledWith(TENANT, `${TENANT}/me.png`);
    expect(renderIntakeFor(generatedVideoInput(input)).portrait_path).toBe(`${TENANT}/me.png`);
    expect(JSON.stringify(mocks.record.mock.calls[0])).toContain("portrait_path");
  });

  it("a founder's photo decides the voice, whatever the agent guessed", async () => {
    mocks.switchedChannelForRun.mockResolvedValue("generated_video");
    mocks.record.mockClear().mockResolvedValue({ id: "action-photo", replayed: false });
    mocks.ownImage.mockReset().mockResolvedValue(undefined);
    look.lookAtPresenterPhoto.mockResolvedValueOnce({ has_person: true, gender: "male" });
    await generatedVideoProposeTool.execute(founderCtx(), { ...VALID_INPUT, presenter_gender: "female", voice: "Jessica", portrait_path: `${TENANT}/me.png` });
    const filed = JSON.stringify(mocks.record.mock.calls[0]);
    expect(filed).toContain('"presenter_gender":"male"');
    expect(filed).toContain('"voice":"Chris"');
  });

  it("a photo that is not this tenant's own writes no card", async () => {
    mocks.switchedChannelForRun.mockResolvedValue("generated_video");
    mocks.record.mockClear();
    mocks.ownImage.mockReset().mockRejectedValue(new Error("not yours"));
    await expect(generatedVideoProposeTool.execute(founderCtx(), { ...VALID_INPUT, portrait_path: "other-tenant/me.png" })).rejects.toThrow("not yours");
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("a web chat shows the card there and never starts a paid render, even for a verified founder", async () => {
    mocks.switchedChannelForRun.mockResolvedValue("generated_video");
    mocks.record.mockResolvedValue({ id: "action-chat", replayed: false });
    mocks.showInChat.mockResolvedValue("shown");
    mocks.chat.mockResolvedValue("started");

    const out = (await generatedVideoProposeTool.execute(founderCtx(), VALID_INPUT)) as Record<string, unknown>;

    expect(mocks.showInChat).toHaveBeenCalledWith(TENANT, RUN, "action-chat");
    expect(mocks.chat).not.toHaveBeenCalled();
    expect(out).toMatchObject({ action_id: "action-chat", proposed: true, rendered: false, in_chat: true });
    expect(out).not.toHaveProperty("started");
    expect(String(out.note)).toContain("in this chat");
    expect(String(out.note)).toContain("Do not send them to the AI UGC Videos channel");
  });

  it("a chat card that could not be shown still spends nothing", async () => {
    mocks.switchedChannelForRun.mockResolvedValue("generated_video");
    mocks.record.mockResolvedValue({ id: "action-chat", replayed: false });
    mocks.showInChat.mockResolvedValue("not_shown");
    mocks.chat.mockResolvedValue("started");

    const out = (await generatedVideoProposeTool.execute(founderCtx(), VALID_INPUT)) as Record<string, unknown>;

    expect(mocks.chat).not.toHaveBeenCalled();
    expect(String(out.note)).toContain("only after they press Make video on it");
  });

  it("a YouTube card is not shown in chat", async () => {
    mocks.switchedChannelForRun.mockResolvedValue("youtube_organic");
    mocks.record.mockResolvedValue({ id: "action-yt", replayed: false });

    await generatedVideoProposeTool.execute(founderCtx(), VALID_INPUT);

    expect(mocks.showInChat).not.toHaveBeenCalled();
  });

  it("starts the video and tells the model not to ask for Make video", async () => {
    mocks.switchedChannelForRun.mockResolvedValue("generated_video");
    mocks.record.mockResolvedValue({ id: "action-chat", replayed: false });
    mocks.chat.mockResolvedValue("started");

    const out = (await generatedVideoProposeTool.execute(founderCtx(), VALID_INPUT)) as Record<string, unknown>;

    expect(mocks.chat).toHaveBeenCalledWith(TENANT, RUN, { actionId: "action-chat", kept: false }, { founder: true, unverified: false, userId: FOUNDER });
    expect(out).toMatchObject({ action_id: "action-chat", proposed: true, rendered: false, started: true });
    expect(out).not.toHaveProperty("starter");
    expect(String(out.note)).toContain("being made now");
    expect(String(out.note)).not.toContain("only after they press Make video");
  });

  it("passes an unverified order and a kept card through for the autostart to refuse", async () => {
    mocks.switchedChannelForRun.mockResolvedValue("generated_video");
    mocks.record.mockResolvedValue({ id: "action-kept", replayed: false, kept: true });

    const out = (await generatedVideoProposeTool.execute(founderCtx({ founder_order_unverified: true }), VALID_INPUT)) as Record<string, unknown>;

    expect(mocks.chat).toHaveBeenCalledWith(TENANT, RUN, { actionId: "action-kept", kept: true }, { founder: true, unverified: true, userId: FOUNDER });
    expect(out).not.toHaveProperty("started");
    expect(String(out.note)).toContain("only after they press Make video on it");
  });

  it.each(["not_chat", "not_first", "failed"])("leaves the card for Make video when the autostart returns %s", async (result) => {
    mocks.switchedChannelForRun.mockResolvedValue("generated_video");
    mocks.record.mockResolvedValue({ id: "action-wait", replayed: false });
    mocks.chat.mockResolvedValue(result);

    const out = (await generatedVideoProposeTool.execute(founderCtx(), VALID_INPUT)) as Record<string, unknown>;

    expect(out).not.toHaveProperty("started");
    expect(String(out.note)).toContain("only after they press Make video on it");
  });

  it("never auto-starts a YouTube card", async () => {
    mocks.switchedChannelForRun.mockResolvedValue("youtube_organic");
    mocks.record.mockResolvedValue({ id: "action-yt", replayed: false });
    mocks.chat.mockResolvedValue("started");

    const out = (await generatedVideoProposeTool.execute(founderCtx(), VALID_INPUT)) as Record<string, unknown>;

    expect(mocks.chat).not.toHaveBeenCalled();
    expect(out).not.toHaveProperty("started");
  });

  it("does not double-start a Start the AI card the starter path already started", async () => {
    mocks.switchedChannelForRun.mockResolvedValue("generated_video");
    mocks.record.mockResolvedValue({ id: "action-starter", replayed: false });
    mocks.autostart.mockResolvedValue("started");
    mocks.chat.mockResolvedValue("started");

    const out = (await generatedVideoProposeTool.execute(founderCtx(), VALID_INPUT)) as Record<string, unknown>;

    expect(mocks.chat).not.toHaveBeenCalled();
    expect(out).toMatchObject({ starter: true });
  });

  it("does not auto-start a capped starter card", async () => {
    mocks.switchedChannelForRun.mockResolvedValue("generated_video");
    mocks.record.mockResolvedValue({ id: "action-two", replayed: false });
    mocks.autostart.mockResolvedValue("capped");
    mocks.chat.mockResolvedValue("started");

    await generatedVideoProposeTool.execute(founderCtx(), VALID_INPUT);

    expect(mocks.chat).not.toHaveBeenCalled();
  });
});
