import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  record: vi.fn(),
  switchedChannelForRun: vi.fn(),
  checkOwnImageForVendor: vi.fn(),
  showInChat: vi.fn(),
  look: vi.fn(),
  filed: vi.fn(),
}));

vi.mock("@/services/video-studio/photo-look", () => ({ lookAtPresenterPhoto: mocks.look }));

vi.mock("../starter-autostart", () => ({ autostartStarterVideo: vi.fn() }));
vi.mock("../chat-card", async (orig) => ({
  ...(await orig<typeof import("../chat-card")>()),
  showVideoCardInChat: mocks.showInChat,
  chatVideoCardFiled: mocks.filed,
}));
vi.mock("@/services/channels/exec-actions", () => ({ recordChannelExecAction: mocks.record }));
vi.mock("@/services/channels/channel-actions", () => ({ switchedChannelForRun: mocks.switchedChannelForRun }));
vi.mock("@/services/chat-images/sign-own-image", () => ({ checkOwnImageForVendor: mocks.checkOwnImageForVendor }));

import { generatedVideoAnimateTool } from "../animate_image";
import { GENERATED_VIDEO_RENDER_CLASS } from "../propose_video";
import { generativeVideoIntakeSchema } from "@/services/launch-video/generative-video-intake";
import { routedVideoPlan } from "@/services/launch-video/video-estimate";
import { costToCredits } from "@/services/agents/credits";
import { DEFAULT_ANIMATE_PROMPT } from "@/services/video-studio/draft";
import { ExpectedToolError } from "@/services/tools/types";

const TENANT = "11111111-1111-1111-1111-111111111111";
const RUN = "22222222-2222-2222-2222-222222222222";
const IMAGE = `${TENANT}/cafe.jpg`;
const ctx = () => ({ tenant_id: TENANT, log: () => {}, run_id: RUN }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.switchedChannelForRun.mockResolvedValue("generated_video");
  mocks.record.mockResolvedValue({ id: "action-1", replayed: false });
  mocks.checkOwnImageForVendor.mockResolvedValue(undefined);
  mocks.showInChat.mockResolvedValue("not_chat");
  mocks.look.mockResolvedValue(null);
  mocks.filed.mockResolvedValue(false);
});

describe("generated_video_animate in a web chat", () => {
  it("a photo of a person writes no card and sends the agent to a presenter script, as the channel does", async () => {
    mocks.look.mockResolvedValue({ has_person: true, gender: "female" });
    const out = (await generatedVideoAnimateTool.execute(ctx(), { image_path: IMAGE, caption: "Our first class is free." })) as Record<string, unknown>;
    expect(out).toMatchObject({ proposed: false, person_in_photo: true });
    expect(String(out.note)).toContain(IMAGE);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("a chat that already has its card writes no second one", async () => {
    mocks.filed.mockResolvedValue(true);
    const out = (await generatedVideoAnimateTool.execute(ctx(), { image_path: IMAGE, caption: "Our first class is free." })) as Record<string, unknown>;
    expect(out).toMatchObject({ proposed: false, one_card: true });
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("a failed photo look still animates rather than losing the founder's image", async () => {
    mocks.look.mockResolvedValue(null);
    const out = (await generatedVideoAnimateTool.execute(ctx(), { image_path: IMAGE, caption: "Our first class is free." })) as Record<string, unknown>;
    expect(out).toMatchObject({ proposed: true });
  });

  it("shows the card in the chat and keeps the founder there", async () => {
    mocks.showInChat.mockResolvedValue("shown");
    const out = (await generatedVideoAnimateTool.execute(ctx(), { image_path: IMAGE, caption: "Our first class is free." })) as Record<string, unknown>;
    expect(mocks.showInChat).toHaveBeenCalledWith(TENANT, RUN, "action-1");
    expect(out).toMatchObject({ proposed: true, rendered: false, in_chat: true });
    expect(String(out.note)).not.toContain("Channels →");
  });
});

describe("generated_video_animate", () => {
  it("writes one approvable card whose intake animates the founder's own image, priced as video.animate, and spends nothing", async () => {
    const out = (await generatedVideoAnimateTool.execute(ctx(), { image_path: IMAGE, caption: "Our first class is free." })) as Record<string, unknown>;
    expect(mocks.checkOwnImageForVendor).toHaveBeenCalledWith(TENANT, IMAGE);
    expect(mocks.record).toHaveBeenCalledTimes(1);
    const card = mocks.record.mock.calls[0][0];
    expect(card.execClass).toBe(GENERATED_VIDEO_RENDER_CLASS);
    expect(card.execPayload.intake).toEqual({ prompt: DEFAULT_ANIMATE_PROMPT, intent: "animate", premium: false, image_path: IMAGE });
    const approved = generativeVideoIntakeSchema.safeParse(card.execPayload.intake);
    expect(approved.success).toBe(true);
    const plan = routedVideoPlan(approved.data!);
    expect(plan.task).toBe("video.animate");
    expect(costToCredits(plan.estimateUsd)).toBe(1514);
    expect(card.body.cost_credits).toBe(1510);
    expect(out).toMatchObject({ action_id: "action-1", proposed: true, rendered: false });
    expect(card.body.step.body).toContain("Press Make video to turn your image");
    expect(card.body.step.body).not.toMatch(/approve/i);
    expect(String(out.note)).toContain("press Make video on it");
    expect(String(out.note)).toContain("Suggested ads");
    expect(String(out.note)).not.toMatch(/approve/i);
  });

  it("an image from another workspace writes nothing", async () => {
    mocks.checkOwnImageForVendor.mockRejectedValue(new ExpectedToolError("image_not_owned", "That image is not in this workspace."));
    await expect(
      generatedVideoAnimateTool.execute(ctx(), { image_path: "99999999-9999-9999-9999-999999999999/x.jpg", caption: "c" }),
    ).rejects.toMatchObject({ code: "image_not_owned" });
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("a run that is not on a video channel writes nothing", async () => {
    mocks.switchedChannelForRun.mockResolvedValue("seo");
    await expect(generatedVideoAnimateTool.execute(ctx(), { image_path: IMAGE, caption: "c" })).rejects.toMatchObject({
      code: "generated_video_propose_wrong_run",
    });
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("motion framed as a customer testimonial is refused", async () => {
    await expect(
      generatedVideoAnimateTool.execute(ctx(), { image_path: IMAGE, motion: "a customer testimonial praising the product", caption: "c" }),
    ).rejects.toMatchObject({ code: "generated_video_customer_voice" });
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it.each(["diners raving about the cake as the camera pushes in", "on-screen text: ★★★★★ best cake ever"])("motion that shows customers endorsing the product is refused: %s", async (motion) => {
    await expect(generatedVideoAnimateTool.execute(ctx(), { image_path: IMAGE, motion, caption: "c" })).rejects.toMatchObject({ code: "generated_video_customer_voice" });
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("motion that makes someone speak as a customer is refused before the image is even checked", async () => {
    await expect(
      generatedVideoAnimateTool.execute(ctx(), { image_path: IMAGE, motion: "she smiles and says I've been using this for months", caption: "c" }),
    ).rejects.toMatchObject({ code: "generated_video_customer_voice" });
    expect(mocks.checkOwnImageForVendor).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });
});
