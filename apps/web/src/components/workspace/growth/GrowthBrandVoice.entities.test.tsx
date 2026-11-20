// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const kit = vi.hoisted(() => ({ source: "default" as string }));
vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async (path: string) =>
    path === "/api/workspace/brand-kit"
      ? { ok: true, status: 200, json: async () => ({ brand_kit: { primary: "#027bff", accent: null, bg: null, text: null, source: kit.source, source_url: null } }) }
      : { ok: false, status: 404, json: async () => ({}) },
  ),
}));

import { GrowthBrandVoice } from "./GrowthBrandVoice";
import type { Personalization } from "../personalization/usePersonalization";

const saved: Personalization = {
  base_tone: "friendly",
  warm: true,
  enthusiastic: false,
  headers_lists: true,
  emoji: false,
  custom_instructions: "",
  brand_voice: "Warm and plain-spoken.",
  response_rules: "",
  version: 3,
  updated_at: null,
  updated_by: null,
};

afterEach(cleanup);

describe("B17: the default colours note reads as words, not HTML", () => {
  it("shows a real apostrophe, never the raw &rsquo; entity", async () => {
    render(<GrowthBrandVoice data={saved} loading={false} loadError={null} canEdit onSave={vi.fn()} />);
    const line = await screen.findByText(/We could not read your site/);
    expect(line.textContent).toBe("We could not read your site’s colours, so these are ours");
    expect(document.body.textContent).not.toMatch(/&[a-z]+;|&#\d+;/);
  });
});
