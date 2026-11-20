import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => {
  const state: { responseText: string; errors: unknown[] } = {
    responseText: "{}",
    errors: [],
  };
  const create = vi.fn(async () => {
    const err = state.errors.shift();
    if (err) throw err;
    return {
      content: [{ type: "text", text: state.responseText }],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  });
  const getAnthropic = vi.fn(() => ({ messages: { create } }));
  return { state, create, getAnthropic };
});

vi.mock("@/services/anthropic", () => ({
  getAnthropic: m.getAnthropic,
  DEFAULT_MODEL: "claude-test",
  heliconePropertyHeaders: () => ({}),
}));
vi.mock("@/services/agents/prompt-injection", () => ({
  renderUntrustedBlock: (label: string, content: string) =>
    `<untrusted ${label}>${content}</untrusted>`,
}));

import { distillTranscript, defaultExpiry } from "../../services/meetings/distill";

const SEGMENTS = [
  {
    speaker: "Hemachandran",
    text: "Credit score threshold is 550, below that subscriptions are blocked and the admin can manually adjust.",
    start_s: 10,
  },
  { speaker: "Jay", text: "I will check the rating card-loading bug today, it is a blocker.", start_s: 60 },
];

beforeEach(() => {
  m.state.responseText = "{}";
  m.state.errors = [];
  m.create.mockClear();
  m.getAnthropic.mockClear();
});

describe("distillTranscript", () => {
  it("reads a saved transcript string exactly like the segments it was saved from", async () => {
    m.state.responseText = JSON.stringify({ atoms: [] });
    await distillTranscript(SEGMENTS, { meeting_date: "2026-06-10" });
    const fromSegments = JSON.stringify((m.create.mock.calls[0] as unknown[])[0]);
    const { transcriptToText } = await import("../../services/meetings/recall");
    await distillTranscript(transcriptToText(SEGMENTS), { meeting_date: "2026-06-10" });
    const fromSaved = JSON.stringify((m.create.mock.calls[1] as unknown[])[0]);
    expect(fromSaved).toBe(fromSegments);
    expect(fromSaved).toContain("Hemachandran: Credit score threshold is 550");
  });

  it("parses valid atoms and drops malformed ones", async () => {
    m.state.responseText = JSON.stringify({
      atoms: [
        {
          atom_type: "spec_fact",
          title: "Subscription credit-score threshold is 550",
          body: "<550 blocked; admin can manually adjust.",
          confidence: "medium",
          memory_class: "canonical",
          source_excerpt: "Credit score threshold is 550",
        },
        {
          atom_type: "blocker",
          title: "Rating flow card not loading",
          owner: "Jay",
          confidence: "high",
          memory_class: "active_ops",
          source_excerpt: "it is a blocker",
        },
        { atom_type: "nonsense_kind", title: "bad", memory_class: "canonical" },
        { atom_type: "blocker" },
      ],
    });
    const atoms = await distillTranscript(SEGMENTS, {
      tenant_name: "UpcarAI",
      meeting_date: "2026-06-10",
    });
    expect(atoms).toHaveLength(2);
    expect(atoms[0].memory_class).toBe("canonical");
    expect(atoms[1].owner).toBe("Jay");
  });

  it("THROWS on unparseable model output (distill failure → caller routes to fallback, not silent 'nothing notable')", async () => {
    m.state.responseText = "I could not produce JSON, sorry!";
    await expect(
      distillTranscript(SEGMENTS, { meeting_date: "2026-06-10" }),
    ).rejects.toThrow(/not parseable/);
  });

  it("returns [] (nothing notable) on a VALID empty result — distinct from unparseable", async () => {
    m.state.responseText = JSON.stringify({ atoms: [] });
    const atoms = await distillTranscript(SEGMENTS, { meeting_date: "2026-06-10" });
    expect(atoms).toEqual([]);
  });

  it("strips markdown fences before parsing", async () => {
    m.state.responseText =
      '```json\n{"atoms":[{"atom_type":"policy","title":"20% sprint capacity for tech debt","memory_class":"canonical","source_excerpt":"20%"}]}\n```';
    const atoms = await distillTranscript(SEGMENTS, { meeting_date: "2026-06-10" });
    expect(atoms).toHaveLength(1);
    expect(atoms[0].atom_type).toBe("policy");
  });

  it("extracts JSON from a prose preamble (regression: 2026-07-16 4965-char distill failure)", async () => {
    m.state.responseText = [
      "Here are the atoms I extracted from the transcript:",
      "",
      JSON.stringify({
        atoms: [
          {
            atom_type: "blocker",
            title: "Rating flow card not loading",
            owner: "Jay",
            confidence: "high",
            memory_class: "active_ops",
            source_excerpt: "it is a blocker",
          },
        ],
      }),
      "",
      "Let me know if you need anything else.",
    ].join("\n");
    const atoms = await distillTranscript(SEGMENTS, { meeting_date: "2026-06-10" });
    expect(atoms).toHaveLength(1);
    expect(atoms[0].atom_type).toBe("blocker");
  });

  it("recovers a prefill-completion response missing the leading '{'", async () => {
    m.state.responseText =
      '"atoms":[{"atom_type":"policy","title":"20% sprint capacity","memory_class":"canonical","source_excerpt":"20%"}]}';
    const atoms = await distillTranscript(SEGMENTS, { meeting_date: "2026-06-10" });
    expect(atoms).toHaveLength(1);
    expect(atoms[0].atom_type).toBe("policy");
  });

  it("ends the messages on the user turn (the 4.6+ models reject an assistant prefill)", async () => {
    m.state.responseText = JSON.stringify({ atoms: [] });
    await distillTranscript(SEGMENTS, { meeting_date: "2026-06-10" });
    const firstCall = m.create.mock.calls[0] as unknown as [
      { messages: Array<{ role: string; content: string }> },
    ];
    const call = firstCall[0];
    const last = call.messages[call.messages.length - 1];
    expect(last.role).toBe("user");
  });

  it("skips the LLM entirely on near-empty transcripts", async () => {
    const atoms = await distillTranscript(
      [{ speaker: "A", text: "hi", start_s: 0 }],
      { meeting_date: "2026-06-10" },
    );
    expect(atoms).toEqual([]);
    expect(m.create).not.toHaveBeenCalled();
  });

  it("retries Anthropic premature-close body failures, then succeeds", async () => {
    m.state.errors = [
      new TypeError(
        "Invalid response body while trying to fetch https://api.anthropic.com/v1/messages: Premature close",
      ),
    ];
    m.state.responseText = JSON.stringify({
      atoms: [
        {
          atom_type: "blocker",
          title: "Rating flow card not loading",
          owner: "Jay",
          confidence: "high",
          memory_class: "active_ops",
          source_excerpt: "it is a blocker",
        },
      ],
    });

    const atoms = await distillTranscript(SEGMENTS, { meeting_date: "2026-06-10" });

    expect(atoms).toHaveLength(1);
    expect(m.create).toHaveBeenCalledTimes(2);
  });

  it("throws after exhausting transport retries (so the caller can fall back)", async () => {
    m.state.errors = [
      new Error("FetchError: ... Premature close"),
      new Error("FetchError: ... Premature close"),
      new Error("FetchError: ... Premature close"),
    ];
    await expect(
      distillTranscript(SEGMENTS, { meeting_date: "2026-06-10" }),
    ).rejects.toThrow(/Premature close/);
    expect(m.create).toHaveBeenCalledTimes(3);
  });

  it("retries an SDK-shaped APIConnectionError ('Connection error.', no .status)", async () => {
    class APIConnectionError extends Error {}
    m.state.errors = [new APIConnectionError("Connection error.")];
    m.state.responseText = JSON.stringify({
      atoms: [
        {
          atom_type: "blocker",
          title: "Rating card not loading",
          confidence: "high",
          memory_class: "active_ops",
          source_excerpt: "it is a blocker",
        },
      ],
    });

    const atoms = await distillTranscript(SEGMENTS, { meeting_date: "2026-06-10" });

    expect(atoms).toHaveLength(1);
    expect(m.create).toHaveBeenCalledTimes(2);
  });

  it("fails fast on a NON-transport error with an HTTP status (a 400 is a real verdict, never retried)", async () => {
    const e = new Error("invalid_request_error: max_tokens too large") as Error & {
      status: number;
    };
    e.status = 400;
    m.state.errors = [e];

    await expect(
      distillTranscript(SEGMENTS, { meeting_date: "2026-06-10" }),
    ).rejects.toThrow(/invalid_request_error/);
    expect(m.create).toHaveBeenCalledTimes(1);
  });
});

describe("defaultExpiry", () => {
  const now = new Date("2026-06-10T17:00:00Z");
  it("active_ops expires in 72h, watchlist in 14d, canonical never", () => {
    expect(defaultExpiry("active_ops", now)?.toISOString()).toBe(
      "2026-06-13T17:00:00.000Z",
    );
    expect(defaultExpiry("watchlist", now)?.toISOString()).toBe(
      "2026-06-24T17:00:00.000Z",
    );
    expect(defaultExpiry("canonical", now)).toBeNull();
  });
});
