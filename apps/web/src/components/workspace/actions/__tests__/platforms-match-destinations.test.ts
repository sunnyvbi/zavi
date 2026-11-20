import { describe, expect, it } from "vitest";
import { CHANNELS, DESTINATIONS } from "@zavi/shared";
import { platformFor } from "../platforms";

describe("web platform rows agree with the shared destination table", () => {
  for (const { slug } of CHANNELS) {
    it(slug, () => {
      const hasComposer = typeof platformFor(slug).composerUrl === "function";
      expect(DESTINATIONS[slug], `${slug} missing from DESTINATIONS`).toBeDefined();
      expect(DESTINATIONS[slug].composer.length > 0, `${slug}: web composerUrl=${hasComposer}`).toBe(hasComposer);
    });
  }
});
