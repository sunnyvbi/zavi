import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/agents/retention-policy", () => ({
  shouldStoreRawTranscripts: vi.fn(async () => false),
}));

import { shouldStoreRawTranscripts } from "@/services/agents/retention-policy";

describe("persistTerminal retention gate", () => {
  it("store_raw=false blanks raw columns in the terminal update", async () => {
    const result = {
      prompt_snapshot: "SYSTEM PROMPT with repo code",
      raw_response_text: "raw model output",
      parsed: { ok: true },
      parse_ok: true,
      parse_error: null,
    };
    const update: Record<string, unknown> = {};
    const storeRaw = await shouldStoreRawTranscripts("run-1");
    update.prompt_snapshot = storeRaw ? result.prompt_snapshot : null;
    update.raw_response_text = storeRaw ? result.raw_response_text : null;
    update.parsed = result.parsed;

    expect(update.prompt_snapshot).toBeNull();
    expect(update.raw_response_text).toBeNull();
    expect(update.parsed).toEqual({ ok: true });
  });
});
