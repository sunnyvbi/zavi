import { describe, it, expect, vi, beforeEach } from "vitest";

const generateMedia = vi.fn();
const isMediaRouterEnabled = vi.fn();
const downloadMedia = vi.fn(async (): Promise<Uint8Array | null> => new Uint8Array([1, 2, 3]));
vi.mock("@/services/media-router/router", () => ({
  generateMedia: (...a: unknown[]) => generateMedia(...a),
  isMediaRouterEnabled: () => isMediaRouterEnabled(),
  estimateCost: () => 0.01,
  downloadMedia: (...a: unknown[]) => downloadMedia(...(a as [])),
}));
const canAffordMedia = vi.fn(async () => true);
vi.mock("@/services/media-router/charge", () => ({
  canAffordMedia: (...a: unknown[]) => canAffordMedia(...(a as [])),
}));

import { synthesizeBeatVo } from "../vo";

const OK = {
  ok: true,
  url: "https://cdn/a.mp3",
  mime: "audio/mpeg",
  vendor: "fal",
  model: "fal-ai/elevenlabs/tts/eleven-v3",
  cost_usd: 0.01,
};

describe("voiceover via the media router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isMediaRouterEnabled.mockResolvedValue(true);
    canAffordMedia.mockResolvedValue(true);
    downloadMedia.mockResolvedValue(new Uint8Array([1, 2, 3]));
  });

  it("speaks each narrated beat and keys the pending charges by VARIANT + beat", async () => {
    generateMedia.mockResolvedValue(OK);
    const r = await synthesizeBeatVo({
      tenant_id: "t",
      run_id: "r",
      variant: "B",
      beats: [{ vo: { srtText: "Hello" } }, {}, { vo: { srtText: "Bye" } }],
    });
    expect(r.audio.size).toBe(2);
    expect(generateMedia).toHaveBeenCalledWith("audio.voiceover", { text: "Hello", voice: "Brian" });
    expect(r.pendingCharges.map((c) => c.key).sort()).toEqual(["r:lv-vo:B:0", "r:lv-vo:B:2"]);
    expect(r.pendingCharges[0]).toMatchObject({
      tenant_id: "t",
      run_id: "r",
      cost_usd: 0.01,
      task: "audio.voiceover",
      model: "fal-ai/elevenlabs/tts/eleven-v3",
    });
  });

  it("two VARIANTS of one run never collapse onto the same key (variant B would be free)", async () => {
    generateMedia.mockResolvedValue(OK);
    const a = await synthesizeBeatVo({ tenant_id: "t", run_id: "r", variant: "A", beats: [{ vo: { srtText: "Hi" } }] });
    const b = await synthesizeBeatVo({ tenant_id: "t", run_id: "r", variant: "B", beats: [{ vo: { srtText: "Hi" } }] });
    expect(a.pendingCharges[0].key).not.toBe(b.pendingCharges[0].key);
  });

  it("not_configured on the probe blocks the run and returns no charges", async () => {
    generateMedia.mockResolvedValue({ ok: false, reason: "not_configured", error: "FAL_KEY not set" });
    const r = await synthesizeBeatVo({
      tenant_id: "t",
      run_id: "r",
      beats: [{ vo: { srtText: "Hello" } }, { vo: { srtText: "Bye" } }],
    });
    expect(r.blocked).toBe("not_configured");
    expect(r.pendingCharges).toEqual([]);
    expect(generateMedia).toHaveBeenCalledTimes(1);
  });

  it("out_of_credits at the vendor reads as a run-wide wallet block", async () => {
    generateMedia.mockResolvedValue({ ok: false, reason: "out_of_credits", error: "wallet empty" });
    const r = await synthesizeBeatVo({ tenant_id: "t", run_id: "r", beats: [{ vo: { srtText: "Hello" } }] });
    expect(r.blocked).toBe("vendor_wallet_exhausted");
    expect(r.pendingCharges).toEqual([]);
  });

  it("CANNOT AFFORD → silent beat, vendor never called, nothing charged", async () => {
    canAffordMedia.mockResolvedValue(false);
    const r = await synthesizeBeatVo({ tenant_id: "t", run_id: "r", beats: [{ vo: { srtText: "Hello" } }] });
    expect(generateMedia).not.toHaveBeenCalled();
    expect(r.audio.size).toBe(0);
    expect(r.pendingCharges).toEqual([]);
  });

  it("a download failure charges nothing (no audio reached the render)", async () => {
    generateMedia.mockResolvedValue(OK);
    downloadMedia.mockResolvedValue(null);
    const r = await synthesizeBeatVo({ tenant_id: "t", run_id: "r", beats: [{ vo: { srtText: "Hello" } }] });
    expect(r.audio.size).toBe(0);
    expect(r.pendingCharges).toEqual([]);
  });

  it("no narrated beats → no router call at all", async () => {
    const r = await synthesizeBeatVo({ tenant_id: "t", run_id: "r", beats: [{}, { vo: {} }] });
    expect(generateMedia).not.toHaveBeenCalled();
    expect(r.pendingCharges).toEqual([]);
    expect(r.blocked).toBeNull();
  });

  it("no variant supplied → the single-variant key shape, unchanged", async () => {
    generateMedia.mockResolvedValue(OK);
    const r = await synthesizeBeatVo({ tenant_id: "t", run_id: "r", beats: [{ vo: { srtText: "Hello" } }] });
    expect(r.pendingCharges[0].key).toBe("r:lv-vo:v0:0");
  });
});
