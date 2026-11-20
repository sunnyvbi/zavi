import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(
  join(__dirname, "..", "..", "routes", "agents", "chat-send.ts"),
  "utf8",
);

describe("chat-send — whitespace-only message rejection (qa-blind v2 TC3, 2026-05-26)", () => {
  it("Zod refine trims the message before the non-empty check", () => {
    expect(SRC).toMatch(/b\.message\?\.trim\(\)\.length/);
  });

  it("rejection message stays stable for client integrations, and names every accepted key", () => {
    expect(SRC).toContain(
      'message: "either message, image_paths, video_paths, or doc_paths must be non-empty"',
    );
    for (const key of ["image_paths", "video_paths", "doc_paths"]) {
      expect(SRC).toMatch(new RegExp(`\\(b\\.${key}\\?\\.length \\?\\? 0\\) > 0`));
    }
  });

  it("comment cites the qa-blind v2 TC3 origin for future spelunkers", () => {
    expect(SRC).toMatch(/qa-blind 2026-05-26 TC3/);
  });
});
