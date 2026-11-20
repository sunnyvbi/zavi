import { describe, it, expect, vi, afterEach } from "vitest";
import { describeVoOutcome, synthesizeBeatVo } from "../vo";

const ORIG_KEY = process.env.HIGGSFIELD_API_KEY;

afterEach(() => {
  if (ORIG_KEY === undefined) delete process.env.HIGGSFIELD_API_KEY;
  else process.env.HIGGSFIELD_API_KEY = ORIG_KEY;
  vi.restoreAllMocks();
});

describe("describeVoOutcome — a silent video is never silent about being silent", () => {
  it("discloses when narration was authored and none of it rendered", () => {
    const d = describeVoOutcome({ authoredVoBeats: 6, voicedBeats: 0, ttsBlocked: "credential_rejected" });
    expect(d.silent).toBe(true);
    expect(d.notice).toBeTruthy();
    expect(d.notice).toMatch(/no voiceover/i);
  });

  it("says nothing when the video actually has narration", () => {
    const d = describeVoOutcome({ authoredVoBeats: 6, voicedBeats: 6, ttsBlocked: null });
    expect(d.state).toBe("voiced");
    expect(d.silent).toBe(false);
    expect(d.notice).toBeNull();
  });

  it("says nothing when no narration was authored (silence is intentional)", () => {
    const d = describeVoOutcome({ authoredVoBeats: 0, voicedBeats: 0, ttsBlocked: "credential_rejected" });
    expect(d.state).toBe("none_authored");
    expect(d.silent).toBe(false);
    expect(d.notice).toBeNull();
  });

  it("still discloses when only SOME beats failed but at least one is voiced", () => {
    const d = describeVoOutcome({ authoredVoBeats: 6, voicedBeats: 2, ttsBlocked: null });
    expect(d.silent).toBe(false);
  });
});

describe("describeVoOutcome — honest about retries in BOTH directions", () => {
  it("does NOT offer a retry while the platform block is in force", () => {
    const d = describeVoOutcome({ authoredVoBeats: 4, voicedBeats: 0, ttsBlocked: "credential_rejected" });
    expect(d.state).toBe("unavailable");
    expect(d.notice).not.toMatch(/ask me to retry/i);
  });

  it("does NOT claim the failure is permanent", () => {
    const d = describeVoOutcome({ authoredVoBeats: 4, voicedBeats: 0, ttsBlocked: "credential_rejected" });
    expect(d.notice).not.toMatch(/retrying will not add narration/i);
    expect(d.notice).not.toMatch(/\b(never|impossible|cannot be done|not supported)\b/i);
    expect(d.notice).toMatch(/temporarily/i);
    expect(d.notice).toMatch(/configuration issue/i);
    expect(d.notice).toMatch(/working on it/i);
  });

  it("does not leak the vendor or our internal stack to the customer", () => {
    const d = describeVoOutcome({ authoredVoBeats: 4, voicedBeats: 0, ttsBlocked: "credential_rejected" });
    expect(d.notice).not.toMatch(/higgsfield/i);
    expect(d.notice).not.toMatch(/elevenlabs/i);
    expect(d.notice).not.toMatch(/401|api key|credential/i);
  });

  it("treats a missing key as the same non-retryable platform block", () => {
    const d = describeVoOutcome({ authoredVoBeats: 4, voicedBeats: 0, ttsBlocked: "not_configured" });
    expect(d.state).toBe("unavailable");
    expect(d.notice).not.toMatch(/ask me to retry/i);
  });

  it("DOES offer a retry when nothing was blocked and the failure was transient", () => {
    const d = describeVoOutcome({ authoredVoBeats: 4, voicedBeats: 0, ttsBlocked: null });
    expect(d.state).toBe("failed");
    expect(d.notice).toMatch(/ask me to retry/i);
  });
});

describe("synthesizeBeatVo — probe once, report the real reason, stay detectable", () => {
  const beats = [
    { vo: { srtText: "line one" } },
    { vo: { srtText: "line two" } },
    { vo: { srtText: "line three" } },
    {},
  ];

  function mock401() {
    return vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ detail: "Invalid or expired token" }),
    } as unknown as Response);
  }

  it("makes a real request even when TTS is expected to fail", async () => {
    process.env.HIGGSFIELD_API_KEY = "key:secret";
    const fetchSpy = mock401();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await synthesizeBeatVo({ tenant_id: "t1", run_id: "r1", beats });
    expect(out.audio.size).toBe(0);
    expect(
      fetchSpy,
      "synthesizeBeatVo produced no HTTP call — a restored credential could never be detected",
    ).toHaveBeenCalled();
  });

  it("probes ONCE and skips the rest — no doomed call per beat", async () => {
    process.env.HIGGSFIELD_API_KEY = "key:secret";
    const fetchSpy = mock401();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await synthesizeBeatVo({ tenant_id: "t1", run_id: "r1", beats });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("reports the block so the disclosure is driven by what happened", async () => {
    process.env.HIGGSFIELD_API_KEY = "key:secret";
    mock401();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await synthesizeBeatVo({ tenant_id: "t1", run_id: "r1", beats });
    expect(out.blocked).toBe("credential_rejected");
    expect(out.blockedError).toMatch(/401/);
  });

  it("logs the unavailability ONCE, naming the real (credential) reason", async () => {
    process.env.HIGGSFIELD_API_KEY = "key:secret";
    mock401();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await synthesizeBeatVo({ tenant_id: "t1", run_id: "r1", beats });
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0][0]);
    expect(msg).toMatch(/voiceover UNAVAILABLE/i);
    expect(msg).toMatch(/401|Invalid or expired token/i);
    expect(msg).not.toMatch(/no text-to-speech endpoint/i);
  });

  it("does NOT short-circuit on a transient failure — every beat gets its own try", async () => {
    process.env.HIGGSFIELD_API_KEY = "key:secret";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "upstream boom",
    } as unknown as Response);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await synthesizeBeatVo({ tenant_id: "t1", run_id: "r1", beats });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(out.blocked).toBeNull();
  });

  it("skips the network entirely when no key is configured", async () => {
    delete process.env.HIGGSFIELD_API_KEY;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await synthesizeBeatVo({ tenant_id: "t1", run_id: "r1", beats });
    expect(out.audio.size).toBe(0);
    expect(out.blocked).toBe("not_configured");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does nothing at all when no beat carries narration", async () => {
    process.env.HIGGSFIELD_API_KEY = "key:secret";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await synthesizeBeatVo({ tenant_id: "t1", run_id: "r1", beats: [{}, {}] });
    expect(out.audio.size).toBe(0);
    expect(out.blocked).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
