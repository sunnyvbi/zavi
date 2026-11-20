import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  callModel: vi.fn(),
}));

vi.mock("@/services/llm/call-model", () => ({ callModel: mocks.callModel }));
vi.mock("@/services/llm/models", () => ({
  MODELS: { anthropic: { haiku: "haiku" } },
  DEFAULT_PROVIDER: "anthropic",
}));

import { dropAlreadyBuilt, generateBuildChips } from "../build-chips-generate";

const BUILD_CHIPS = JSON.stringify([
  { label: "Design Booking Flow", prompt: "Design the booking flow." },
  { label: "Build Admin Dashboard", prompt: "Build an admin dashboard." },
  { label: "Add Booking Data Model", prompt: "Add a booking data model." },
  { label: "Create Payment Checkout", prompt: "Create a payment checkout." },
  { label: "Add Email Confirmations", prompt: "Add email confirmations." },
]);

const OWNER_CHIPS = JSON.stringify([
  { label: "Add Opening Hours", prompt: "Add my opening hours to the site." },
  { label: "Test a Booking", prompt: "Walk me through a test booking." },
  { label: "Build Admin Dashboard", prompt: "Build an admin dashboard." },
  { label: "Share Your Link", prompt: "How do I share my site's link?" },
]);

const OBJECTIVE = "Build product: Paws & Suds — a dog grooming booking site where customers book a grooming slot";
const ROUTES = "ROUTE FILES\nsrc/app/page.tsx\nsrc/app/book/page.tsx\nsrc/app/admin/page.tsx\nsrc/app/api/bookings/route.ts";

const labels = (chips: Array<{ label: string }>) => chips.map((c) => c.label);

beforeEach(() => {
  mocks.callModel.mockReset();
});

describe("generateBuildChips once the build is ready", () => {
  it("a chip set cached while building is not served after the build becomes ready", async () => {
    mocks.callModel.mockImplementation(async (req: { system: string }) => ({
      text: /finished and ready/.test(req.system) ? OWNER_CHIPS : BUILD_CHIPS,
    }));
    const base = {
      tenantId: "tenant-ready-1",
      turnKey: "session-1:root",
      objective: OBJECTIVE,
      priorRefines: [],
      readAppContext: async () => ROUTES,
    };

    const building = await generateBuildChips({ ...base, ready: false });
    const buildingAgain = await generateBuildChips({ ...base, ready: false });
    const ready = await generateBuildChips({ ...base, ready: true });
    const readyAgain = await generateBuildChips({ ...base, ready: true });

    expect(labels(building)).toContain("Build Admin Dashboard");
    expect(buildingAgain).toEqual(building);
    expect(labels(ready)).toEqual(["Add Opening Hours", "Test a Booking", "Share Your Link"]);
    expect(readyAgain).toEqual(ready);
    expect(mocks.callModel).toHaveBeenCalledTimes(2);
  });

  it("asks for owner next steps for this site and lists what it already has as off limits", async () => {
    mocks.callModel.mockResolvedValue({ text: OWNER_CHIPS });

    await generateBuildChips({
      tenantId: "tenant-ready-2",
      turnKey: "session-2:root",
      objective: OBJECTIVE,
      priorRefines: ["[refine] add a gallery of past grooms"],
      readAppContext: async () => ROUTES,
      ready: true,
    });

    const req = mocks.callModel.mock.calls[0][0] as { system: string; messages: Array<{ content: string }> };
    expect(req.system).not.toMatch(/next build actions/);
    expect(req.system).toMatch(/OWNER/);
    const user = req.messages[0].content;
    const alreadyAt = user.indexOf("Already in the site");
    expect(alreadyAt).toBeGreaterThan(-1);
    expect(user.indexOf("add a gallery of past grooms")).toBeGreaterThan(alreadyAt);
    expect(user).toContain("src/app/admin/page.tsx");
  });

  it("a ready site asks for improvements the site does not have yet, with at most one owner task, and keeps new feature chips", async () => {
    mocks.callModel.mockImplementation(async () => ({
      text: JSON.stringify([
        { label: "Email Order Confirmations", prompt: "Email each customer a confirmation after they order." },
        { label: "Add Size Guide", prompt: "Add a size guide so visitors can pick the right mat." },
        { label: "Share Your Shop Link", prompt: "Help me share my shop link." },
      ]),
    }));
    const chips = await generateBuildChips({
      tenantId: "t-improve",
      turnKey: "run-improve",
      objective: "A landing page for my yoga mat shop",
      priorRefines: [],
      ready: true,
      readAppContext: async () => "src/pages/Home.tsx\nsrc/pages/Login.tsx",
    });
    const req = mocks.callModel.mock.calls.at(-1)![0] as { system: string };
    expect(req.system).toMatch(/next improvements/);
    expect(req.system).toMatch(/At most one suggestion may be an owner task/);
    expect(req.system).not.toMatch(/Test a Booking/);
    expect(labels(chips)).toEqual(["Email Order Confirmations", "Add Size Guide", "Share Your Shop Link"]);
  });

  it("drops model chips that would rebuild what the site already has, and falls back to owner steps when none survive", async () => {
    mocks.callModel.mockResolvedValue({ text: BUILD_CHIPS });

    const chips = await generateBuildChips({
      tenantId: "tenant-ready-3",
      turnKey: "session-3:root",
      objective: OBJECTIVE,
      priorRefines: [],
      readAppContext: async () => `${ROUTES}\nsrc/app/api/payment/route.ts\nsrc/lib/email.ts`,
      ready: true,
    });

    expect(labels(chips)).not.toContain("Build Admin Dashboard");
    expect(labels(chips)).not.toContain("Design Booking Flow");
    expect(labels(chips)).not.toContain("Add Booking Data Model");
    expect(labels(chips)).toEqual(["Add Opening Hours", "Test a Booking", "Update Services & Prices", "Share Your Link"]);
  });

  it("the model failing on a ready site falls back to owner next steps, not build actions", async () => {
    mocks.callModel.mockRejectedValue(new Error("haiku down"));

    const chips = await generateBuildChips({
      tenantId: "tenant-ready-4",
      turnKey: "session-4:root",
      objective: OBJECTIVE,
      priorRefines: ["[refine] add opening hours to the footer"],
      ready: true,
    });

    expect(labels(chips)).toEqual(["Test a Booking", "Update Services & Prices", "Share Your Link"]);
  });
});

describe("dropAlreadyBuilt for suggestions that do not start with a build verb", () => {
  const chip = (label: string) => ({ key: label.toLowerCase().replace(/\s+/g, "-"), label, prompt: `${label}.` });

  it("drops a verb-less suggestion whose every key word is already in the site", () => {
    const evidence = ["src/emails/orderConfirmation.tsx sends an order confirmation email after checkout"];
    expect(dropAlreadyBuilt([chip("Email Order Confirmations")], evidence)).toEqual([]);
  });

  it("keeps a verb-less suggestion that only shares one word with the site", () => {
    const evidence = ["src/pages/Order.tsx lets a visitor place an order"];
    expect(dropAlreadyBuilt([chip("Email Order Confirmations")], evidence).map((c) => c.label)).toEqual(["Email Order Confirmations"]);
  });

  it("keeps the old rule for verb-led suggestions", () => {
    const evidence = ["src/pages/Admin.tsx admin dashboard"];
    expect(dropAlreadyBuilt([chip("Build Admin Dashboard"), chip("Add Size Guide")], evidence).map((c) => c.label)).toEqual(["Add Size Guide"]);
  });
});
