import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { runFinishPass } from "../finish-pass";
import { wordsFromCharTimings } from "@/services/media-router/word-timings";

const on = process.env.FINISH_E2E === "1";

describe.skipIf(!on)("finish pass, end to end in a real sandbox", () => {
  it(
    "edits a real talking-head video and uploads the result",
    async () => {
      const words = wordsFromCharTimings(JSON.parse(readFileSync(process.env.FINISH_E2E_TIMINGS!, "utf8")));
      if (process.env.FINISH_E2E_NO_WORDS !== "1") expect(words.length).toBeGreaterThan(5);
      const r = await runFinishPass({
        tenant_id: "00000000-0000-0000-0000-00000000e2e0",
        rawUrl: process.env.FINISH_E2E_RAW_URL!,
        uploadUrl: process.env.FINISH_E2E_UPLOAD_URL!,
        words,
        videoSeconds: Number(process.env.FINISH_E2E_SECONDS),
        hook: process.env.FINISH_E2E_HOOK,
      });
      expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
      if (r.ok) {
        expect(r.bytes).toBeGreaterThan(100_000);
        expect(r.duration_s).toBeLessThanOrEqual(Number(process.env.FINISH_E2E_SECONDS) + 0.05);
      }
    },
    15 * 60 * 1000,
  );
});
