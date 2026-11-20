
import { describe, it, expect, vi, beforeEach } from "vitest";

const { callModel } = vi.hoisted(() => ({ callModel: vi.fn() }));
vi.mock("@/services/llm/call-model", () => ({ callModel }));

import {
  answeredByIdea,
  businessNameFromTitle,
  distinctiveNameChoices,
  generateClarifyQuestions,
  isGenericName,
  nameSearchQuery,
  parseClarifyJson,
  realBusinessNames,
} from "../clarify-questions-generate";

function clarifyCall(): unknown {
  return callModel.mock.calls.map((c) => c[0] as { system?: string }).find((a) => !String(a.system ?? "").startsWith("You name new businesses"));
}

describe("parseClarifyJson", () => {
  it("returns [] for empty / non-array / unparseable input", () => {
    expect(parseClarifyJson("")).toEqual([]);
    expect(parseClarifyJson("not json at all")).toEqual([]);
    expect(parseClarifyJson('{"header":"x"}')).toEqual([]);
    expect(parseClarifyJson("[")).toEqual([]);
  });

  it("parses a well-formed array of questions with choices", () => {
    const text = JSON.stringify([
      {
        header: "Audience",
        text: "Who is this marketplace for?",
        why: "shapes onboarding",
        choices: ["Renters", "Owners", "Both"],
      },
      {
        header: "Payments",
        text: "How do owners get paid?",
        why: "drives the money flow",
        choices: [],
      },
    ]);
    const qs = parseClarifyJson(text);
    expect(qs.length).toBe(2);
    expect(qs[0].header).toBe("Audience");
    expect(qs[0].text).toContain("marketplace");
    expect(qs[0].choices.map((c) => c.label)).toEqual(["Renters", "Owners", "Both"]);
    for (const q of qs) {
      expect(q.id).toBeTruthy();
      expect(q.allowOther).toBe(true);
      for (const c of q.choices) expect(c.id).toBeTruthy();
    }
  });

  it("tolerates code fences / surrounding prose around the JSON array", () => {
    const text =
      "Here are the questions:\n```json\n" +
      JSON.stringify([{ header: "Scope", text: "MVP or full?", why: "", choices: [] }]) +
      "\n```\nHope that helps!";
    const qs = parseClarifyJson(text);
    expect(qs.length).toBe(1);
    expect(qs[0].header).toBe("Scope");
  });

  it("accepts object-shaped choices ({label}) as well as bare strings", () => {
    const text = JSON.stringify([
      {
        header: "Style",
        text: "How often do people visit?",
        choices: [{ label: "Minimal" }, "Bold", { notLabel: "skip" }],
      },
    ]);
    const qs = parseClarifyJson(text);
    expect(qs[0].choices.map((c) => c.label)).toEqual(["Minimal", "Bold"]);
  });

  it("caps at 4 questions and 4 choices each", () => {
    const text = JSON.stringify(
      Array.from({ length: 6 }, (_, i) => ({
        header: `H${i}`,
        text: `Question ${i}?`,
        choices: ["a", "b", "c", "d", "e", "f"],
      })),
    );
    const qs = parseClarifyJson(text);
    expect(qs.length).toBe(4);
    for (const q of qs) expect(q.choices.length).toBeLessThanOrEqual(4);
  });

  it("skips items missing a header or text", () => {
    const text = JSON.stringify([
      { header: "", text: "no header" },
      { header: "NoText", text: "" },
      { header: "Good", text: "Keep me", choices: [] },
    ]);
    const qs = parseClarifyJson(text);
    expect(qs.length).toBe(1);
    expect(qs[0].header).toBe("Good");
  });

  it("gives distinct ids to same-slug headers", () => {
    const text = JSON.stringify([
      { header: "Scope", text: "one?", choices: [] },
      { header: "Scope", text: "two?", choices: [] },
    ]);
    const qs = parseClarifyJson(text);
    expect(qs.length).toBe(2);
    expect(qs[0].id).not.toBe(qs[1].id);
  });
});

describe("parseClarifyJson name question and recommended", () => {
  it("moves the name question first, gives it id 'name' and the fixed text, keeps the model's recommended pick", () => {
    const text = JSON.stringify([
      { header: "Audience", text: "Who books?", choices: [{ label: "Owners" }, { label: "Walkers", recommended: true }] },
      { header: "Payments", text: "Pay how?", choices: [] },
      {
        id: "name",
        header: "Brand",
        text: "Name?",
        why: "Your address uses it",
        choices: [{ label: "Wag Club" }, { label: "Paws & Suds", recommended: true }, { label: "Tailwind Walks" }],
      },
    ]);
    const qs = parseClarifyJson(text);
    expect(qs.map((q) => q.id)[0]).toBe("name");
    expect(qs[0]).toMatchObject({ header: "Name", text: "What do you have in mind for the name?", why: "Your address uses it" });
    expect(qs[0].choices.map((c) => [c.label, c.recommended])).toEqual([
      ["Wag Club", false],
      ["Paws & Suds", true],
      ["Tailwind Walks", false],
    ]);
    expect(qs.slice(1).map((q) => q.header)).toEqual(["Audience", "Payments"]);
    expect(qs[1].choices.map((c) => c.recommended)).toEqual([false, true]);
  });

  it("recognises the name question by its header, and defaults its first choice to recommended", () => {
    const qs = parseClarifyJson(
      JSON.stringify([{ header: "name", text: "Name it?", choices: ["Hush", "Quiet Co"] }, { header: "Hours", text: "Open late?", choices: ["Yes"] }]),
    );
    expect(qs[0].id).toBe("name");
    expect(qs[0].choices.map((c) => c.recommended)).toEqual([true, false]);
    expect(qs[1].choices.map((c) => c.recommended)).toEqual([false]);
  });

  it("only a literal boolean true counts as recommended, and only the first one", () => {
    const qs = parseClarifyJson(
      JSON.stringify([
        {
          header: "Style",
          text: "Open late?",
          choices: [
            { label: "A", recommended: "true" },
            { label: "B", recommended: 1 },
            { label: "C", recommended: true },
            { label: "D", recommended: true },
          ],
        },
      ]),
    );
    expect(qs[0].choices.map((c) => c.recommended)).toEqual([false, false, true, false]);
  });

  it("a second name-like question is an ordinary question, and the name question does not crowd out three scoping questions", () => {
    const qs = parseClarifyJson(
      JSON.stringify([
        { header: "Audience", text: "a?", choices: [] },
        { header: "Goal", text: "b?", choices: [] },
        { header: "Style", text: "c?", choices: [] },
        { id: "name", header: "Name", text: "n?", choices: ["X Co"] },
        { header: "Name", text: "again?", choices: [] },
      ]),
    );
    expect(qs.map((q) => q.header)).toEqual(["Name", "Audience", "Goal", "Style"]);
    expect(qs.filter((q) => q.id === "name").length).toBe(1);
  });
});

describe("generateClarifyQuestions", () => {
  beforeEach(() => {
    callModel.mockReset();
  });

  it("asks the question call for the name question first returns the name first, and caches it", async () => {
    callModel.mockResolvedValue({
      text: JSON.stringify([
        { id: "name", header: "Name", text: "x", choices: [{ label: "Sweet Crumbs", recommended: true }, "Rise Bakery", "Flour Hour"] },
        { header: "Audience", text: "Who?", choices: ["Locals"] },
        { header: "Orders", text: "Pickup?", choices: [] },
        { header: "Style", text: "Look?", choices: ["Warm"] },
      ]),
    });
    const qs = await generateClarifyQuestions({ tenantId: "t-single-call", idea: "A bakery website in the old town" }, { search: async () => [] });
    expect(callModel).toHaveBeenCalledTimes(1);
    const arg = clarifyCall() as { system: string; max_tokens: number; messages: unknown[] };
    expect(arg.system).toContain('"id": "name"');
    expect(arg.system).toContain("What do you have in mind for the name?");
    expect(arg.system).toContain("EXACTLY 4");
    expect(arg.max_tokens).toBeLessThanOrEqual(800);
    expect(arg.messages).toHaveLength(1);
    expect(qs.map((q) => q.id)[0]).toBe("name");
    expect(qs[0].choices[0]).toMatchObject({ label: "Sweet Crumbs", recommended: true });
    expect(qs).toHaveLength(4);

    await generateClarifyQuestions({ tenantId: "t-single-call", idea: "A bakery website in the old town" });
    expect(callModel).toHaveBeenCalledTimes(1);
  });

  it("a model failure returns [] so the web falls back", async () => {
    callModel.mockRejectedValue(new Error("down"));
    expect(await generateClarifyQuestions({ tenantId: "t-fail", idea: "A dog walking app for Pune" }, { search: async () => [] })).toEqual([]);
    expect(callModel).toHaveBeenCalledTimes(1);
  });

});

describe("parseClarifyJson name choices from an escaped idea", async () => {
  const { parseClarifyJson } = await import("../clarify-questions-generate");

  it("decodes entities the model echoed back and treats a 'Business name' header as the one name question", () => {
    const out = parseClarifyJson(
      JSON.stringify([
        { header: "Business name", text: "x", choices: [{ label: "Salt &amp; Pepper" }, { label: "Joe&#39;s" }] },
        { header: "Audience", text: "Who?", choices: ["Locals"] },
      ]),
    );
    expect(out.filter((q) => q.id === "name")).toHaveLength(1);
    expect(out[0].choices.map((c) => c.label)).toEqual(["Salt & Pepper", "Joe's"]);
    expect(out[0].choices[0].recommended).toBe(true);
  });
});

describe("the build questions never ask about the logo", () => {
  beforeEach(() => {
    callModel.mockReset();
  });

  const mentionsLogo = (q: { id: string; header: string; text: string; why: string; choices: Array<{ label: string }> }) =>
    /logo/i.test([q.id, q.header, q.text, q.why, ...q.choices.map((c) => c.label)].join(" "));

  it("keeps four name suggestions and drops every logo question the model writes, whatever it is called", () => {
    const qs = parseClarifyJson(
      JSON.stringify([
        { id: "name", header: "Name", text: "x", choices: ["Brightside", "Northlight", "Kindred", "Fieldnote", "Extra"] },
        { header: "Logo", text: "Want a logo?", choices: ["Yes"] },
        { id: "logo", header: "Mark", text: "Pick a mark", choices: ["Leaf"] },
        { header: "Branding", text: "Should we design a logo for you?", choices: ["Yes", "No"] },
        { header: "Audience", text: "Who is it for?", choices: ["Locals"] },
      ]),
    );
    expect(qs.map((q) => q.id)).toEqual(["name", "audience-0"]);
    expect(qs[0].choices.map((c) => c.label)).toEqual(["Brightside", "Northlight", "Kindred", "Fieldnote"]);
    expect(qs.some(mentionsLogo)).toBe(false);
  });

  it("never adds a logo question of its own", () => {
    const qs = parseClarifyJson(
      JSON.stringify([
        { id: "name", header: "Name", text: "x", choices: ["A"] },
        { header: "Audience", text: "Who?", choices: [] },
      ]),
    );
    expect(qs.map((q) => q.header)).toEqual(["Name", "Audience"]);
  });
});

describe("the build questions never ask about the look", () => {
  it("drops every style, colour, font or theme question the model writes and keeps real scoping questions", () => {
    const qs = parseClarifyJson(
      JSON.stringify([
        { id: "name", header: "Name", text: "x", choices: ["Crumb & Co"] },
        { header: "Style", text: "What design style do you want?", choices: ["Minimal", "Bold"] },
        { id: "colors", header: "Colours", text: "Which colour palette fits your brand?", choices: ["Warm"] },
        { header: "Fonts", text: "Serif or sans-serif fonts?", choices: ["Serif"] },
        { header: "Vibe", text: "What vibe should the site have?", choices: ["Cozy"] },
        { header: "Look", text: "What look and feel do you want?", choices: [] },
        { header: "Ordering", text: "Should visitors order online or call?", choices: ["Online"] },
      ]),
    );
    expect(qs.map((q) => q.header)).toEqual(["Name", "Ordering"]);
  });

  it("keeps a business question that only shares a word with styling", () => {
    const qs = parseClarifyJson(
      JSON.stringify([
        { id: "name", header: "Name", text: "x", choices: ["Myra Salon"] },
        { header: "Services", text: "Which hair styles do you offer?", choices: ["Cuts", "Colour"] },
        { header: "Cuisine", text: "What style of cuisine do you serve?", choices: ["Italian"] },
      ]),
    );
    expect(qs.map((q) => q.header)).toEqual(["Name", "Services", "Cuisine"]);
  });
});

describe("name suggestions grounded in real businesses", () => {
  beforeEach(() => callModel.mockReset());

  it("searches the idea's first line and keeps the business part of each title", async () => {
    expect(nameSearchQuery("Bike rental in Austin\n\nAdditional context:\n- Name: x")).toBe("Bike rental in Austin business names");
    expect(businessNameFromTitle("Mellow Johnny's Bike Shop | Austin, TX - Yelp")).toBe("Mellow Johnny's Bike Shop");
    expect(businessNameFromTitle("THE BEST 10 Bike Rentals in Austin")).toBeNull();
    const search = vi.fn(async () => ["Bicycle Sport Shop - Austin", "Mellow Johnny's | Home", "Bicycle Sport Shop (South)"]);
    expect(await realBusinessNames("Bike rental in Austin", search)).toEqual(["Bicycle Sport Shop", "Mellow Johnny's"]);
  });

  it("a failing or slow search is no names, never an error", async () => {
    expect(await realBusinessNames("Bike rental in Austin", async () => {
      throw new Error("down");
    })).toEqual([]);
    vi.useFakeTimers();
    const slow = realBusinessNames("Bike rental in Austin", () => new Promise(() => undefined));
    await vi.advanceTimersByTimeAsync(3_100);
    expect(await slow).toEqual([]);
    vi.useRealTimers();
  });

  it("flags stock compounds and keeps real-sounding names", () => {
    for (const n of ["RentHub", "MobileRent", "FlexPhone", "DeviceShare", "Smart Rent", "CycleHub"]) expect(isGenericName(n)).toBe(true);
    for (const n of ["Petal & Crumb", "Holly's Bakes", "Mango Tree", "Butterfly Studio", "Myra Salon", "Spoke & Pedal"]) expect(isGenericName(n)).toBe(false);
  });

  it("drops generic and copied names, keeps the idea's own name, and keeps a recommended pick", () => {
    const q = parseClarifyJson(
      JSON.stringify([{ id: "name", header: "Name", text: "x", choices: [{ label: "RentHub", recommended: true }, "Spoke & Pedal", "Mellow Johnny's", "Barton Wheels"] }]),
    )[0]!;
    const out = distinctiveNameChoices(q, "A bike rental shop", ["Mellow Johnny's"]);
    expect(out.choices.map((c) => c.label)).toEqual(["Spoke & Pedal", "Barton Wheels"]);
    expect(out.choices[0]!.recommended).toBe(true);
    const own = distinctiveNameChoices(q, "A bike rental called RentHub", []);
    expect(own.choices.map((c) => c.label)).toContain("RentHub");
  });

  it("passes the real names to the model as data and filters its answer", async () => {
    callModel.mockResolvedValue({
      text: JSON.stringify([{ id: "name", header: "Name", text: "x", choices: ["CycleHub", "Spoke & Pedal", "Barton Wheels", "Mellow Johnny's"] }]),
    });
    const qs = await generateClarifyQuestions(
      { tenantId: "t-grounded", idea: "Bike rental shop in Austin" },
      { search: async () => ["Mellow Johnny's | Austin"] },
    );
    const arg = clarifyCall() as { system: string; messages: Array<{ content: string }> };
    expect(arg.messages[0]!.content).toContain("Mellow Johnny's");
    expect(arg.system).toMatch(/never a stock compound/);
    expect(qs[0]!.choices.map((c) => c.label)).toEqual(["Spoke & Pedal", "Barton Wheels"]);
  });
});

describe("never asks what the idea already says", () => {
  beforeEach(() => callModel.mockReset());

  const CAKE = "A cake shop website. Anybody can order a cake from my website.";
  const modelSet = () => ({
    text: JSON.stringify([
      { id: "name", header: "Name", text: "x", choices: ["Crumb & Co", "Velvet Oven", "Sugar Lane", "Batter Days"] },
      { header: "Audience", text: "Who is this app for?", choices: ["Consumers", "Businesses"] },
      { header: "Core action", text: "What's the ONE main thing a user does here?", choices: [] },
      { header: "Delivery", text: "Pickup, delivery or both?", choices: ["Both", "Pickup only"] },
    ]),
  });

  it("drops the audience and core-action questions for an idea that names who orders and what they do, keeping the open one", async () => {
    callModel.mockResolvedValue(modelSet());
    const qs = await generateClarifyQuestions({ tenantId: "t-cake", idea: CAKE }, { search: async () => [] });
    expect(qs.map((q) => q.header)).toEqual(["Name", "Delivery"]);
    const arg = clarifyCall() as { system: string; messages: Array<{ content: string }> };
    expect(arg.system).toMatch(/never something the idea already says/);
    expect(arg.system).not.toMatch(/EXACTLY 3 items/);
  });

  it("keeps both questions for an idea that leaves them open", async () => {
    callModel.mockResolvedValue(modelSet());
    const qs = await generateClarifyQuestions({ tenantId: "t-cake-open", idea: "A cake shop in the old town" }, { search: async () => [] });
    expect(qs.map((q) => q.header)).toEqual(["Name", "Audience", "Core action", "Delivery"]);
  });

  it("an idea that answers everything is served as the name question alone, not as empty", async () => {
    callModel.mockResolvedValue({
      text: JSON.stringify([
        { id: "name", header: "Name", text: "x", choices: ["Velvet Oven"] },
        { header: "Audience", text: "Who orders?", choices: ["Locals"] },
        { header: "Main goal", text: "What should visitors do?", choices: [] },
      ]),
    });
    const qs = await generateClarifyQuestions({ tenantId: "t-cake-all", idea: CAKE }, { search: async () => [] });
    expect(qs.map((q) => q.id)).toEqual(["name"]);
  });

  it("matches on what the idea says, through escaped text, and drops the name question only when the idea names the business", () => {
    const audience = { id: "audience-0", header: "Audience", text: "Who is it for?", why: "", choices: [], allowOther: true };
    const action = { id: "core-0", header: "Core action", text: "What's the ONE main thing a user does here?", why: "", choices: [], allowOther: true };
    const name = { id: "name", header: "Name", text: "Who names it?", why: "", choices: [], allowOther: true };
    expect(answeredByIdea(audience, "Cakes for anyone in Pune")).toBe(true);
    expect(answeredByIdea(audience, "Cakes &amp; customers")).toBe(true);
    expect(answeredByIdea(audience, "Horse tinder")).toBe(false);
    expect(answeredByIdea(action, "People can book a table")).toBe(true);
    expect(answeredByIdea(action, "A car rental site")).toBe(false);
    expect(answeredByIdea(name, "Cakes for anyone")).toBe(false);
    expect(answeredByIdea(name, "A cake site. The name of the website will be Cakee.")).toBe(true);
    expect(answeredByIdea(name, "A cake site Additional context: - Name: Use the business name given in the idea above.")).toBe(false);
  });

  it("an idea that names the business is never asked for a name", async () => {
    callModel.mockResolvedValue(modelSet());
    const qs = await generateClarifyQuestions({ tenantId: "t-cake-named", idea: "Cake shop site, the website name will be Cakee. Anybody can order a cake." }, { search: async () => [] });
    expect(qs.map((q) => q.header)).toEqual(["Delivery"]);
  });
});

describe("the served set never asks about a logo", () => {
  beforeEach(() => callModel.mockReset());

  const mentionsLogo = (q: { id: string; header: string; text: string; why: string; choices: Array<{ label: string }> }) =>
    /logo/i.test([q.id, q.header, q.text, q.why, ...q.choices.map((c) => c.label)].join(" "));

  it("what the route serves has no logo question, even when the model's set leaves room for one", async () => {
    callModel.mockResolvedValue({
      text: JSON.stringify([
        { id: "name", header: "Name", text: "x", choices: ["Sweet Crumbs", "Rise", "Flour Hour", "Crumb Co"] },
        { header: "Audience", text: "Who?", choices: ["Locals"] },
        { header: "Brand mark", text: "Do you want a logo?", choices: ["Yes", "No logo"] },
      ]),
    });
    const qs = await generateClarifyQuestions({ tenantId: "t-no-logo", idea: "A bakery website in the old town" });
    expect(qs.map((q) => q.header)).toEqual(["Name", "Audience"]);
    expect(qs.some(mentionsLogo)).toBe(false);

    callModel.mockResolvedValue({ text: JSON.stringify([{ header: "Audience", text: "Who?", choices: [] }]) });
    const unnamed = await generateClarifyQuestions({ tenantId: "t-no-logo-2", idea: "A dog walking app for Pune" });
    expect(unnamed.map((q) => q.header)).toEqual(["Audience"]);
    const arg = clarifyCall() as { system: string };
    expect(arg.system).toMatch(/never about the name, a logo, or the look/);
  });

  it("the web step carries no logo question of its own", () => {
    const web = readFileSync(resolve(__dirname, "../../../../../web/src/components/workspace/home/BuildClarifyStep.tsx"), "utf8");
    expect(web).not.toMatch(/Do you want a logo\?/);
    expect(web).not.toMatch(/- Logo:/);
  });
});

describe("distinctiveNameChoices: a name the idea gives vs a category word", async () => {
  const { distinctiveNameChoices, namedInIdea } = await import("../clarify-questions-generate");
  const q = (labels: string[]) => ({
    id: "name",
    header: "Name",
    text: "x",
    choices: labels.map((label, i) => ({ id: `c${i}`, label, recommended: i === 0 })),
  });

  it("drops a one-word category at the start of the idea, never recommending it as the name", () => {
    const out = distinctiveNameChoices(q(["Bakery", "Crumb & Co", "Golden Loaf"]) as never, "Bakery website for my shop", []);
    expect(out.choices.map((c) => c.label)).toEqual(["Crumb & Co", "Golden Loaf"]);
    expect(out.choices[0]).toMatchObject({ recommended: true });
  });

  it("keeps a name the founder gave, puts it first and recommends it", () => {
    const out = distinctiveNameChoices(q(["Rise Bakery", "Sweet Crumbs"]) as never, "A bakery website called Sweet Crumbs", []);
    expect(out.choices[0]).toMatchObject({ label: "Sweet Crumbs", recommended: true });
    expect(out.choices.filter((c) => c.recommended)).toHaveLength(1);
  });

  it("recognises a one-word name inside the idea and a 2-word heading name, not a leading category", () => {
    expect(namedInIdea("Kaku", "Help me to make Kaku landing page")).toBe(true);
    expect(namedInIdea("Sweet Crumbs", "Sweet Crumbs: a bakery site")).toBe(true);
    expect(namedInIdea("Bakery", "Bakery website for my shop")).toBe(false);
  });
});

it("keeps workflow questions that begin with Who when the idea already names an audience", () => {
  const question = { id: "approvals", header: "Approvals", text: "Who approves purchase requests?", why: "", choices: [], allowOther: true };
  expect(answeredByIdea(question, "A purchasing portal where teams submit requests")).toBe(false);
});
