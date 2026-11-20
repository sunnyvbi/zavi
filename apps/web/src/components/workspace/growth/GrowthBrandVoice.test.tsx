import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  GrowthBrandVoice,
  invalidColour,
  neverSayToRule,
  ruleToNeverSay,
  splitWords,
} from "./GrowthBrandVoice";
import type { Personalization, PersonalizationPatch } from "../personalization/usePersonalization";

const api = vi.hoisted(() => ({ brandKit: null as Record<string, unknown> | null }));
vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async (path: string, init?: { method?: string }) =>
    path === "/api/workspace/brand-kit" && !init?.method && api.brandKit
      ? new Response(JSON.stringify({ brand_kit: api.brandKit }), { status: 200 })
      : new Response("{}", { status: 404 }),
  ),
}));

const saved: Personalization = {
  base_tone: "friendly",
  warm: true,
  enthusiastic: false,
  headers_lists: true,
  emoji: false,
  custom_instructions: "",
  brand_voice: "Warm and plain-spoken. Short sentences.",
  response_rules: "Never use these words or phrases: artisanal, curated.",
  version: 3,
  updated_at: null,
  updated_by: null,
};

describe("never-say list", () => {
  it("round-trips through the rule sentence the agents read", () => {
    const rule = neverSayToRule(["artisanal", "curated"]);
    expect(rule).toBe("Never use these words or phrases: artisanal, curated.");
    expect(ruleToNeverSay(rule)).toEqual(["artisanal", "curated"]);
  });

  it("leaves unrelated rules alone rather than reading them as words", () => {
    expect(ruleToNeverSay("Always answer in under 100 words.")).toEqual([]);
  });

  it("drops blanks and duplicates", () => {
    expect(splitWords("artisanal, , Artisanal, curated")).toEqual(["artisanal", "curated"]);
  });

  it("returns nothing for an empty list, so no rule line is written", () => {
    expect(neverSayToRule([" ", ""])).toBe("");
  });
});

describe("GrowthBrandVoice", () => {
  afterEach(() => cleanup());

  it("renders the same fields in the personalization frame", () => {
    render(
      <GrowthBrandVoice
        variant="personalization"
        data={saved}
        loading={false}
        loadError={null}
        canEdit
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByText("Warm and plain-spoken. Short sentences.")).toBeTruthy();
    expect(screen.getByText("Friendly")).toBeTruthy();
    expect(screen.getByText("artisanal")).toBeTruthy();
    expect(document.querySelector("#brand-voice")).toBeTruthy();
  });

  it("saves from the personalization frame through the same onSave", async () => {
    const onSave = vi.fn().mockResolvedValue(saved);
    render(
      <GrowthBrandVoice
        variant="personalization"
        data={saved}
        loading={false}
        loadError={null}
        canEdit
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByLabelText("Edit brand voice"));
    fireEvent.change(screen.getByLabelText("How we sound"), { target: { value: "Plain and direct." } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].brand_voice).toBe("Plain and direct.");
  });

  it("shows the saved voice, tone and never-say words", () => {
    render(<GrowthBrandVoice data={saved} loading={false} loadError={null} canEdit onSave={vi.fn()} />);
    expect(screen.getByText("Warm and plain-spoken. Short sentences.")).toBeTruthy();
    expect(screen.getByText("Friendly")).toBeTruthy();
    expect(screen.getByText("Warm")).toBeTruthy();
    expect(screen.getByText("artisanal")).toBeTruthy();
  });

  it("says a voice was drafted from the site until a person edits it", () => {
    const { rerender } = render(
      <GrowthBrandVoice data={saved} loading={false} loadError={null} canEdit onSave={vi.fn()} />,
    );
    expect(screen.getByText(/drafted from your site/)).toBeTruthy();
    rerender(
      <GrowthBrandVoice
        data={{ ...saved, updated_by: "user-1" }}
        loading={false}
        loadError={null}
        canEdit
        onSave={vi.fn()}
      />,
    );
    expect(screen.queryByText(/drafted from your site/)).toBeNull();
  });

  it("says it is not set yet instead of inventing a voice", () => {
    render(
      <GrowthBrandVoice
        data={{ ...saved, brand_voice: "", response_rules: "" }}
        loading={false}
        loadError={null}
        canEdit
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByText(/Not set yet/)).toBeTruthy();
  });

  it("hides Edit from a member", () => {
    render(<GrowthBrandVoice data={saved} loading={false} loadError={null} canEdit={false} onSave={vi.fn()} />);
    expect(screen.queryByLabelText("Edit brand voice")).toBeNull();
  });

  it("saves the voice, the tone and the never-say list together", async () => {
    const onSave = vi.fn(async (_patch: PersonalizationPatch) => saved);
    render(<GrowthBrandVoice data={saved} loading={false} loadError={null} canEdit onSave={onSave} />);
    fireEvent.click(screen.getByLabelText("Edit brand voice"));
    fireEvent.change(screen.getByLabelText("How we sound"), { target: { value: "Plain and direct." } });
    fireEvent.click(screen.getByRole("button", { name: "Direct" }));
    fireEvent.change(screen.getByLabelText("Words to never say"), { target: { value: "synergy, unlock" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0]).toEqual({
      brand_voice: "Plain and direct.",
      base_tone: "direct",
      warm: true,
      enthusiastic: false,
      response_rules: "Never use these words or phrases: synergy, unlock.",
    });
  });

  it("keeps an unrelated rule when the never-say list is saved", async () => {
    const onSave = vi.fn(async (_patch: PersonalizationPatch) => saved);
    render(
      <GrowthBrandVoice
        data={{ ...saved, response_rules: "Always answer in under 100 words." }}
        loading={false}
        loadError={null}
        canEdit
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByLabelText("Edit brand voice"));
    fireEvent.change(screen.getByLabelText("Words to never say"), { target: { value: "synergy" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].response_rules).toBe(
      "Always answer in under 100 words. Never use these words or phrases: synergy.",
    );
  });
});

describe("colour validation", () => {
  it("requires a main colour and accepts blanks for the rest", () => {
    expect(invalidColour({ primary: "#1a73ff", accent: "", bg: "", text: "" })).toBeNull();
    expect(invalidColour({ primary: "1a73ff", accent: "", bg: "", text: "" })).toMatch(/Main colour/);
    expect(invalidColour({ primary: "#1a73ff", accent: "blue", bg: "", text: "" })).toMatch(/Accent colour/);
  });
});

describe("GrowthBrandVoice colours note (QA B17)", () => {
  afterEach(() => {
    cleanup();
    api.brandKit = null;
  });

  it("shows a real apostrophe when the site's colours could not be read, never &rsquo;", async () => {
    api.brandKit = { primary: "#1a73ff", accent: null, bg: null, text: null, source: "default", source_url: null };
    render(
      <GrowthBrandVoice variant="personalization" data={saved} loading={false} loadError={null} canEdit onSave={vi.fn()} />,
    );
    await screen.findByText("We could not read your site’s colours, so these are ours");
    expect(document.body.textContent).not.toContain("&rsquo;");
  });
});
