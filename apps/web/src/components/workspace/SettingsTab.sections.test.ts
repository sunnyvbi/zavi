import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));

import { settingsSectionsFor } from "./SettingsTab";

describe("Settings sections", () => {
  it("has no Setup or Personalization tab for anyone", () => {
    for (const readOnly of [false, true]) {
      const ids: string[] = settingsSectionsFor(readOnly).map((s) => s.id);
      expect(ids).not.toContain("setup");
      expect(ids).not.toContain("workspace");
    }
  });

  it("members keep their read-only subset", () => {
    expect([...settingsSectionsFor(true).map((s) => s.id)].sort()).toEqual(
      ["account", "company", "email", "feedback", "integration", "personalization", "reporting", "rules", "team"],
    );
  });
});
