import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  callModel: vi.fn(),
}));

vi.mock("@/services/llm/call-model", () => ({ callModel: mocks.callModel }));
vi.mock("@/services/llm/models", () => ({
  MODELS: { anthropic: { haiku: "haiku" } },
  DEFAULT_PROVIDER: "anthropic",
}));

import { generateBuildChips } from "../build-chips-generate";

const CHIPS = JSON.stringify([
  { label: "Add Fleet Cards", prompt: "Add a fleet section." },
  { label: "Add Booking CTA", prompt: "Add a booking call to action." },
  { label: "Explain Pricing", prompt: "Add a pricing section." },
]);

beforeEach(() => {
  mocks.callModel.mockReset();
  mocks.callModel.mockResolvedValue({ text: CHIPS });
});

describe("generateBuildChips app context reads", () => {
  it("reads the repo once per turn, not on every poll that hits the chip cache", async () => {
    const readAppContext = vi.fn(async () => "ROUTE FILES\nsrc/app/page.tsx");
    const args = {
      tenantId: "tenant-a",
      turnKey: "session-1:root",
      objective: "Make a bike rental landing page for tourists.",
      priorRefines: [],
      readAppContext,
    };

    const first = await generateBuildChips(args);
    const second = await generateBuildChips(args);
    const third = await generateBuildChips(args);

    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(readAppContext).toHaveBeenCalledTimes(1);
    expect(mocks.callModel).toHaveBeenCalledTimes(1);
  });

  it("reads the repo again when a new turn busts the cache", async () => {
    const readAppContext = vi.fn(async () => null);
    const base = {
      tenantId: "tenant-b",
      objective: "An online store selling coffee.",
      priorRefines: [],
      readAppContext,
    };

    await generateBuildChips({ ...base, turnKey: "session-2:root" });
    await generateBuildChips({ ...base, turnKey: "session-2:refine-1" });

    expect(readAppContext).toHaveBeenCalledTimes(2);
  });

  it("lets the static fallback read route paths, never words inside page source", async () => {
    mocks.callModel.mockRejectedValue(new Error("model down"));
    const chips = await generateBuildChips({
      tenantId: "tenant-d",
      turnKey: "session-4:root",
      objective: "A simple site for my bakery.",
      priorRefines: [],
      readAppContext: async () =>
        "ROUTE FILES\nsrc/app/page.tsx\n\nFILE src/app/page.tsx\nexport default function Home(){ return <p>Ready in about five minutes, contact us anytime</p> }",
    });
    const keys = chips.map((c) => c.key);
    expect(keys).toContain("gen-about");
    expect(keys).toContain("gen-contact");
  });

  it("feeds the repo evidence to the model on a cache miss", async () => {
    await generateBuildChips({
      tenantId: "tenant-c",
      turnKey: "session-3:root",
      objective: "A blog about coffee.",
      priorRefines: [],
      readAppContext: async () => "ROUTE FILES\nsrc/app/pricing/page.tsx",
    });

    const call = mocks.callModel.mock.calls[0]?.[0] as { messages: Array<{ content: string }> };
    expect(call.messages[0]?.content).toContain("src/app/pricing/page.tsx");
  });
});

describe("generateBuildChips more suggestions", () => {
  it("never repeats a label already shown, tells the model what was shown, and caches each set", async () => {
    mocks.callModel.mockResolvedValue({
      text: JSON.stringify([
        { label: "Add Fleet Cards", prompt: "Add a fleet section." },
        { label: "Add Gift Cards", prompt: "Sell gift cards." },
        { label: "Add Reviews", prompt: "Show customer reviews." },
      ]),
    });
    const args = {
      tenantId: "tenant-more",
      turnKey: "session-9:root",
      objective: "A bike rental site.",
      priorRefines: [],
      exclude: ["Add Fleet Cards", "Explain Pricing"],
    };
    const more = await generateBuildChips(args);
    expect(more.map((c) => c.label)).toEqual(["Add Gift Cards", "Add Reviews"]);
    const user = (mocks.callModel.mock.calls[0]![0] as { messages: Array<{ content: string }> }).messages[0]!.content;
    expect(user).toContain("Already suggested");
    expect(user).toContain("- Explain Pricing");
    await generateBuildChips(args);
    expect(mocks.callModel).toHaveBeenCalledTimes(1);
    await generateBuildChips({ ...args, exclude: [] });
    expect(mocks.callModel).toHaveBeenCalledTimes(2);
  });

  it("falls back to the static chips minus the shown ones when the model fails", async () => {
    mocks.callModel.mockRejectedValue(new Error("down"));
    const base = { tenantId: "tenant-more-2", turnKey: "s:root", objective: "An online store selling coffee.", priorRefines: [] };
    const plain = await generateBuildChips(base);
    expect(plain.length).toBeGreaterThan(0);
    const more = await generateBuildChips({ ...base, turnKey: "s:root2", exclude: [plain[0]!.label] });
    expect(more.some((c) => c.label === plain[0]!.label)).toBe(false);
  });
});

describe("generateBuildChips more cap", () => {
  it("asks allowMore only on a cache miss of a more read, and calls no model when refused", async () => {
    mocks.callModel.mockClear();
    const allowMore = vi.fn(async () => false);
    const out = await generateBuildChips({ tenantId: "tenant-cap", turnKey: "c:root", objective: "A bakery.", priorRefines: [], exclude: ["Add Menu"], allowMore });
    expect(out).toEqual([]);
    expect(allowMore).toHaveBeenCalledTimes(1);
    expect(mocks.callModel).not.toHaveBeenCalled();
    const plain = vi.fn(async () => false);
    await generateBuildChips({ tenantId: "tenant-cap", turnKey: "c:root", objective: "A bakery.", priorRefines: [], allowMore: plain });
    expect(plain).not.toHaveBeenCalled();
  });
});

describe("takeMoreSlot", () => {
  it("claims through the given client; a failed claim throws (no model call, not capped)", async () => {
    const { takeMoreSlot, MORE_PER_BUILD, MORE_PER_TENANT_PER_DAY } = await import("../build-chips-generate");
    const rpc = vi.fn(async () => ({ data: true, error: null }));
    expect(await takeMoreSlot({ rpc }, "t-1", "b-1")).toBe(true);
    expect(rpc).toHaveBeenCalledWith("claim_build_chip_more", { p_tenant_id: "t-1", p_build_id: "b-1", p_per_build: MORE_PER_BUILD, p_per_day: MORE_PER_TENANT_PER_DAY });
    expect(await takeMoreSlot({ rpc: async () => ({ data: false, error: null }) }, "t-1", "b-1")).toBe(false);
    await expect(takeMoreSlot({ rpc: async () => ({ data: null, error: { message: "boom" } }) }, "t-1", "b-1")).rejects.toThrow(/boom/);
    await expect(takeMoreSlot({ rpc: async () => { throw new Error("down"); } }, "t-1", "b-1")).rejects.toThrow(/down/);
  });
});
