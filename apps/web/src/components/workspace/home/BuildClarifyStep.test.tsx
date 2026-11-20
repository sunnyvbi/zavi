// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const flags = vi.hoisted(() => ({ dynamic: false }));
const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/lib/workspace/builderClarifyFlag", () => ({
  isBuilderClarifyDynamicEnabled: () => flags.dynamic,
}));

import { BuildClarifyStep, ideaGivesName, ideaIsDetailed } from "./BuildClarifyStep";

const NAME_TEXT = "What do you have in mind for the name?";

beforeEach(() => {
  flags.dynamic = false;
  apiFetch.mockReset();
});
afterEach(cleanup);

function setup(idea = "Horse tinder") {
  const onComplete = vi.fn();
  render(<BuildClarifyStep idea={idea} onComplete={onComplete} onSkip={vi.fn()} />);
  return onComplete;
}

function serve(questions: unknown) {
  flags.dynamic = true;
  apiFetch.mockResolvedValue({ ok: true, json: async () => ({ questions }) });
}

const radio = (name: string | RegExp) => screen.getByRole("radio", { name });
const radios = () => screen.queryAllByRole("radio");
const otherBox = () => screen.getByRole("textbox") as HTMLTextAreaElement;
const next = () => fireEvent.click(screen.getByRole("button", { name: /Next|Continue/ }));
const key = (k: string, target: Element | Window = window) => fireEvent.keyDown(target, { key: k });
const checked = () => radios().map((r) => r.getAttribute("aria-checked") === "true");

describe("BuildClarifyStep answers (#25)", () => {
  it("clicking the selected choice again clears it", () => {
    setup();
    next();
    fireEvent.click(radio("Consumers"));
    expect(radio("Consumers").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(radio("Consumers"));
    expect(radio("Consumers").getAttribute("aria-checked")).toBe("false");
  });

  it("typing in Other keeps the pick, and picking keeps the typed text", () => {
    setup();
    next();
    fireEvent.click(radio("Consumers"));
    fireEvent.change(otherBox(), { target: { value: "parents of toddlers" } });
    expect(radio("Consumers").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(radio("Businesses"));
    expect(otherBox().value).toBe("parents of toddlers");
  });

  it("sends the pick and the typed detail together", () => {
    const onComplete = setup();
    next();
    fireEvent.click(radio("Consumers"));
    fireEvent.change(otherBox(), { target: { value: "parents of toddlers" } });
    next();
    fireEvent.change(otherBox(), { target: { value: "Swipe on horses" } });
    next();
    expect(onComplete).toHaveBeenCalledWith(
      "Horse tinder\n\nAdditional context:\n" +
        "- Audience: Consumers: parents of toddlers\n" +
        "- Core action: Swipe on horses",
    );
  });

  it("a cleared pick with no text adds nothing", () => {
    const onComplete = setup();
    next();
    fireEvent.click(radio("Consumers"));
    fireEvent.click(radio("Consumers"));
    next();
    next();
    expect(onComplete).toHaveBeenCalledWith("Horse tinder");
  });
});

describe("the name question comes first", () => {
  it("static fallback: step 1 of 3 is the name question, numbered, with the recommended option first", () => {
    setup();
    expect(screen.getByText(NAME_TEXT)).toBeTruthy();
    expect(screen.getByText("1 of 3")).toBeTruthy();
    const all = radios();
    expect(all.map((r) => r.textContent)).toEqual([
      "1.Suggest a name for me(Recommended)",
      "2.A plain name that says what it does",
      "3.Use the name in my idea",
    ]);
    expect(radio(/Suggest a name for me/).textContent).toContain("(Recommended)");
    expect(all.filter((r) => r.textContent?.includes("(Recommended)"))).toHaveLength(1);
    expect(screen.getByText("4.")).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: NAME_TEXT })).toBeTruthy();
    expect(screen.getByLabelText("Type a name")).toBe(otherBox());
  });

  it("every question uses the numbered style", () => {
    setup();
    next();
    expect(radios().map((r) => r.textContent)).toEqual(["1.Consumers", "2.Businesses", "3.My internal team", "4.Just me"]);
    expect(screen.getByText("5.")).toBeTruthy();
  });

  it("server questions without a name question still open on the name question", async () => {
    serve([
      { id: "audience-0", header: "Audience", text: "Who rides?", why: "", choices: [{ id: "a", label: "Kids" }] },
      { id: "style-1", header: "Style", text: "Which look?", why: "", choices: [] },
    ]);
    setup();
    expect(await screen.findByText(NAME_TEXT)).toBeTruthy();
    expect(screen.getByText("1 of 3")).toBeTruthy();
    expect(radio(/Suggest a name for me/).textContent).toContain("(Recommended)");
    next();
    expect(screen.getByText("Who rides?")).toBeTruthy();
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it("four server questions without a name question are trimmed so the step stays at four", async () => {
    serve(
      ["A", "B", "C", "D"].map((h, i) => ({ id: `q${i}`, header: h, text: `${h}?`, why: "", choices: [] })),
    );
    setup();
    expect(await screen.findByText(NAME_TEXT)).toBeTruthy();
    expect(screen.getByText("1 of 4")).toBeTruthy();
  });

  it("a server name question sent last is moved first, its recommended name leads, and Suggest is added", async () => {
    serve([
      { id: "audience-0", header: "Audience", text: "Who rides?", why: "", choices: [{ id: "a", label: "Kids" }] },
      {
        id: "name",
        header: "Name",
        text: NAME_TEXT,
        why: "Names the site",
        choices: [
          { id: "wag-0", label: "Wag Club", recommended: false },
          { id: "paws-1", label: "Paws & Suds", recommended: true },
          { id: "trot-2", label: "Trot Co" },
        ],
      },
    ]);
    const onComplete = setup("Dog grooming in Pune");
    expect(await screen.findByText(NAME_TEXT)).toBeTruthy();
    expect(radios().map((r) => r.textContent)).toEqual([
      "1.Paws & Suds(Recommended)",
      "2.Wag Club",
      "3.Trot Co",
      "4.Suggest a name for me",
    ]);
    key("1");
    next();
    next();
    expect(onComplete).toHaveBeenCalledWith(
      'Dog grooming in Pune\n\nAdditional context:\n- Name: The business is called "Paws & Suds".',
    );
  });

  it("malformed recommended values never tag a choice, and a name question with none defaults to its first", async () => {
    serve([
      {
        id: "name",
        header: "Name",
        text: NAME_TEXT,
        why: "",
        choices: [
          { id: "x", label: "Xeno", recommended: "true" },
          { id: "y", label: "Yarn", recommended: 1 },
        ],
      },
      {
        id: "style-1",
        header: "Style",
        text: "Which look?",
        why: "",
        choices: [
          { id: "a", label: "Calm", recommended: "yes" },
          { id: "b", label: "Loud", recommended: 1 },
          { id: "c", label: "Odd", recommended: null },
          { id: "d", label: "Raw", recommended: { v: true } },
        ],
      },
    ]);
    setup();
    expect(await screen.findByText(NAME_TEXT)).toBeTruthy();
    expect(radios().map((r) => r.textContent)).toEqual(["1.Xeno(Recommended)", "2.Yarn", "3.Suggest a name for me"]);
    next();
    expect(radios().map((r) => r.textContent)).toEqual(["1.Calm", "2.Loud", "3.Odd", "4.Raw"]);
    expect(screen.queryByText("(Recommended)")).toBeNull();
  });

  it("a server name question with no choices gets the static choices", async () => {
    serve([{ id: "name", header: "Name", text: NAME_TEXT, why: "", choices: [] }]);
    setup();
    expect(await screen.findByText(NAME_TEXT)).toBeTruthy();
    expect(radios()).toHaveLength(3);
    expect(radios()[0].textContent).toContain("Suggest a name for me");
  });
});

describe("keyboard", () => {
  it("a digit picks that option and pressing it again keeps it picked", () => {
    setup();
    key("2");
    expect(checked()).toEqual([false, true, false]);
    key("2");
    expect(checked()).toEqual([false, true, false]);
    key("3");
    expect(checked()).toEqual([false, false, true]);
  });

  it("the free-text number focuses the box without typing the digit, and digits typed in the box do not pick", () => {
    setup();
    key("4");
    expect(document.activeElement).toBe(otherBox());
    expect(otherBox().value).toBe("");
    key("1", otherBox());
    expect(checked()).toEqual([false, false, false]);
    key("Enter", otherBox());
    expect(screen.getByText("1 of 3")).toBeTruthy();
  });

  it.each([6, 10])("with %i choices every digit does what its printed number says", async (count) => {
    const labels = Array.from({ length: count }, (_, i) => `Pick ${String.fromCharCode(65 + i)}`);
    serve([
      { id: "name", header: "Name", text: NAME_TEXT, why: "", choices: [{ id: "n", label: "Neigh", recommended: true }] },
      { id: "look", header: "Look", text: "Which look?", why: "", choices: labels.map((label, i) => ({ id: `c${i}`, label })), allowOther: true },
    ]);
    setup();
    expect(await screen.findByText(NAME_TEXT)).toBeTruthy();
    next();
    expect(screen.getByText("Which look?")).toBeTruthy();

    const printed = new Map<string, string>();
    for (const r of radios()) {
      const m = /^(\d)\.(.*)$/.exec(r.textContent ?? "");
      if (m) printed.set(m[1], m[2]);
    }
    const otherNumber = count < 9 ? String(count + 1) : null;
    if (otherNumber) expect(screen.getByText(`${otherNumber}.`)).toBeTruthy();
    expect(screen.getByText(`Press 1 to ${Math.min(count + 1, 9)} to choose, Enter to continue`)).toBeTruthy();

    for (let d = 1; d <= 9; d++) {
      const digit = String(d);
      (document.activeElement as HTMLElement | null)?.blur();
      key(digit);
      const picked = radios().find((r) => r.getAttribute("aria-checked") === "true");
      if (printed.has(digit)) {
        expect(picked?.textContent).toBe(`${digit}.${printed.get(digit)}`);
        expect(document.activeElement).not.toBe(otherBox());
      } else if (digit === otherNumber) {
        expect(document.activeElement).toBe(otherBox());
      }
    }
    expect(printed.size).toBe(Math.min(count, 9));
    const shown = radios().map((r) => (r.textContent ?? "").replace(/^✓/, ""));
    expect(shown).toHaveLength(count);
    expect(shown.filter((t) => /^\d\./.test(t)).map((t) => t.slice(0, 2))).toEqual(
      Array.from({ length: Math.min(count, 9) }, (_, i) => `${i + 1}.`),
    );
  });

  it("digits with a modifier or out of range do nothing", () => {
    setup();
    fireEvent.keyDown(window, { key: "1", ctrlKey: true });
    fireEvent.keyDown(window, { key: "1", metaKey: true });
    key("9");
    expect(checked()).toEqual([false, false, false]);
  });

  it("Enter outside the box steps through and completes with the keyed answers", () => {
    const onComplete = setup();
    key("1");
    key("Enter");
    expect(screen.getByText("2 of 3")).toBeTruthy();
    key("4");
    key("Enter");
    key("Enter");
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith(
      "Horse tinder\n\nAdditional context:\n" +
        "- Name: No name yet. Suggest a short, memorable name for the business and use it on the site.\n" +
        "- Audience: Just me",
    );
  });

  it("Enter on a focused button is left to the button, so it never double fires", () => {
    const onComplete = setup();
    const skip = screen.getByRole("button", { name: "Skip all" });
    key("Enter", skip);
    expect(screen.getByText("1 of 3")).toBeTruthy();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("keys do nothing while the questions are loading, and the listener is removed on unmount", async () => {
    flags.dynamic = true;
    let release: (v: unknown) => void = () => {};
    apiFetch.mockReturnValue(new Promise((r) => (release = r)));
    const onComplete = vi.fn();
    const { unmount } = render(<BuildClarifyStep idea="Horse tinder" onComplete={onComplete} onSkip={vi.fn()} />);
    key("Enter");
    key("Enter");
    key("Enter");
    key("Enter");
    expect(onComplete).not.toHaveBeenCalled();
    await act(async () => release({ ok: false, json: async () => ({}) }));
    expect(screen.getByText(NAME_TEXT)).toBeTruthy();
    unmount();
    key("Enter");
    expect(onComplete).not.toHaveBeenCalled();
  });
});

describe("what the name answer adds to the idea", () => {
  function finish(onComplete: ReturnType<typeof vi.fn>) {
    next();
    next();
    next();
    return onComplete.mock.calls[0][0] as string;
  }

  it("Use the name in my idea asks the build to keep the idea's own name", () => {
    const onComplete = setup();
    fireEvent.click(radio(/Use the name in my idea/));
    expect(finish(onComplete)).toBe(
      "Horse tinder\n\nAdditional context:\n- Name: Use the business name given in the idea above.",
    );
  });

  it("a typed name becomes the business name, stripped of quotes and line breaks", () => {
    const onComplete = setup();
    fireEvent.change(otherBox(), { target: { value: '  "Neigh\nBors"  ' } });
    expect(finish(onComplete)).toBe('Horse tinder\n\nAdditional context:\n- Name: The business is called "Neigh Bors".');
  });

  it("a typed name beats a picked option, but not Suggest, where it is a hint", () => {
    const first = setup();
    fireEvent.click(radio(/Use the name in my idea/));
    fireEvent.change(otherBox(), { target: { value: "Stable Hearts" } });
    expect(finish(first)).toBe('Horse tinder\n\nAdditional context:\n- Name: The business is called "Stable Hearts".');
    cleanup();
    const second = setup();
    fireEvent.click(radio(/Suggest a name for me/));
    fireEvent.change(otherBox(), { target: { value: "something with hooves" } });
    const out = finish(second);
    expect(out).toBe(
      "Horse tinder\n\nAdditional context:\n- Name: No name yet. Suggest a short, memorable name for the business and use it on the site. Ideas to start from: something with hooves.",
    );
    expect(out).not.toMatch(/called|named/);
  });

  it("Suggest alone never reads as a literal name", () => {
    const onComplete = setup();
    fireEvent.click(radio(/Suggest a name for me/));
    const out = finish(onComplete);
    expect(out).not.toContain('called "');
    expect(out).not.toMatch(/\bnamed\b/);
    expect(out).toContain("Suggest a short, memorable name");
  });

  it("A plain name asks for a descriptive name", () => {
    const onComplete = setup();
    fireEvent.click(radio("A plain name that says what it does"));
    expect(finish(onComplete)).toBe(
      "Horse tinder\n\nAdditional context:\n- Name: Use a plain name that says what the business does.",
    );
  });
});

describe("the build questions never ask about the logo", () => {
  const LOGO_WORD = /logo/i;

  function walk(onComplete: ReturnType<typeof vi.fn>) {
    const seen: string[] = [];
    for (let i = 0; i < 10 && onComplete.mock.calls.length === 0; i++) {
      seen.push(document.body.textContent ?? "");
      next();
    }
    return seen;
  }

  it("the built-in questions are the name, the audience and the core action, and none of them mentions a logo", () => {
    const onComplete = setup("A bakery in the old town");
    expect(screen.getByText("1 of 3")).toBeTruthy();
    const seen = walk(onComplete);
    expect(seen).toHaveLength(3);
    for (const text of seen) expect(text).not.toMatch(LOGO_WORD);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith("A bakery in the old town");
  });

  it("a logo question from the server, by id, by header or in its text, is never shown and never adds a Logo line", async () => {
    serve([
      { id: "name", header: "Name", text: NAME_TEXT, why: "", choices: ["A", "B", "C", "D"].map((l, i) => ({ id: `n${i}`, label: `Name ${l}`, recommended: i === 0 })) },
      { id: "logo", header: "Logo", text: "Do you want a logo?", why: "", choices: [{ id: "logo-yes", label: "Yes, add a logo", recommended: true }, { id: "logo-none", label: "No logo, just the name" }] },
      { id: "brand-1", header: "Branding", text: "Should Zavi design a logo for you?", why: "", choices: [{ id: "y", label: "Yes" }] },
      { id: "audience-0", header: "Audience", text: "Who?", why: "", choices: [{ id: "l", label: "Locals" }] },
    ]);
    const onComplete = setup("A bakery in the old town");
    expect(await screen.findByText(NAME_TEXT)).toBeTruthy();
    expect(screen.getByText("1 of 2")).toBeTruthy();
    key("1");
    next();
    expect(screen.getByText("Who?")).toBeTruthy();
    key("1");
    next();
    expect(onComplete).toHaveBeenCalledTimes(1);
    const idea = onComplete.mock.calls[0][0] as string;
    expect(idea).toBe('A bakery in the old town\n\nAdditional context:\n- Name: The business is called "Name A".\n- Audience: Locals');
    expect(idea).not.toMatch(LOGO_WORD);
  });
});

describe("never asks what the idea already says", () => {
  const CAKE = "A cake shop website. Anybody can order a cake from my website.";

  it("the built-in set skips who it is for and what users do when the idea says both, and completes after the name", () => {
    const onComplete = setup(CAKE);
    expect(screen.getByText("1 of 1")).toBeTruthy();
    key("1");
    key("Enter");
    expect(screen.queryByText("Who is this app for?")).toBeNull();
    expect(screen.queryByText(/main thing a user does/)).toBeNull();
    expect(onComplete).toHaveBeenCalledWith(
      `${CAKE}\n\nAdditional context:\n- Name: No name yet. Suggest a short, memorable name for the business and use it on the site.`,
    );
  });

  it("an idea that names only the audience still asks what users do", () => {
    setup("Cakes for anybody in Pune");
    expect(screen.getByText("1 of 2")).toBeTruthy();
    next();
    expect(screen.getByText(/main thing a user does/)).toBeTruthy();
  });

  it("server questions the idea already answers are dropped too", async () => {
    serve([
      { id: "name", header: "Name", text: NAME_TEXT, why: "", choices: [{ id: "a", label: "Velvet Oven", recommended: true }] },
      { id: "audience-0", header: "Audience", text: "Who is this app for?", why: "", choices: [{ id: "c", label: "Consumers" }] },
      { id: "delivery-1", header: "Delivery", text: "Pickup or delivery?", why: "", choices: [{ id: "b", label: "Both" }] },
    ]);
    setup(CAKE);
    await screen.findByText("1 of 2");
    next();
    expect(screen.getByText("Pickup or delivery?")).toBeTruthy();
    expect(screen.queryByText("Who is this app for?")).toBeNull();
  });
});

describe("a name already in the idea is never asked for", () => {
  it("the idea names the site and says who and what, so the step completes with the idea unchanged and shows no question", () => {
    const idea = "A cake shop website. The name of the website will be Cakee. Anybody can order a cake.";
    const onComplete = setup(idea);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith(idea);
    expect(screen.queryByText(NAME_TEXT)).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("a named idea with open questions skips straight past the name, and the server's name question is dropped too", async () => {
    serve([
      { id: "name", header: "Name", text: NAME_TEXT, why: "", choices: [{ id: "a", label: "Velvet Oven", recommended: true }] },
      { id: "delivery-1", header: "Delivery", text: "Pickup or delivery?", why: "", choices: [{ id: "b", label: "Both" }] },
    ]);
    const onComplete = setup('Cake site called "Cakee by AE"');
    await screen.findByText("Pickup or delivery?");
    expect(screen.queryByText(NAME_TEXT)).toBeNull();
    expect(screen.getByText("1 of 1")).toBeTruthy();
    fireEvent.click(radio("Both"));
    next();
    expect(onComplete).toHaveBeenCalledWith('Cake site called "Cakee by AE"\n\nAdditional context:\n- Delivery: Both');
  });

  it("the founder's own name or a placeholder is not a business name, so the name question stays", () => {
    setup("Hi, my name is Ravi and I run a bakery");
    expect(screen.getByText(NAME_TEXT)).toBeTruthy();
    cleanup();
    setup("a cake shop, name it something fun");
    expect(screen.getByText(NAME_TEXT)).toBeTruthy();
  });

  it("an idea with no name never recommends using the name in the idea", () => {
    setup("help me to make the cake rental website");
    expect(radio(/Use the name in my idea/).textContent).not.toContain("(Recommended)");
    expect(radios()[0].textContent).toContain("Suggest a name for me");
  });
});

describe("a fully answered idea never flashes the loading step", () => {
  const KUKI = "I want to make my own biscuit shop where people can come and buy biscuits and order them. I have a biscuit shop of mine called Kuki Kaka";

  it("is recognised as needing no questions", async () => {
    const { ideaAnswersEverything } = await import("./BuildClarifyStep");
    expect(ideaAnswersEverything(KUKI)).toBe(true);
    expect(ideaAnswersEverything("Horse tinder")).toBe(false);
    expect(ideaAnswersEverything("A biscuit shop called Kuki Kaka")).toBe(false);
  });

  it("with dynamic questions on, it never asks the server, never renders the loading skeleton, and completes with the idea", () => {
    serve([{ id: "audience-0", header: "Audience", text: "Who buys?", why: "", choices: [] }]);
    const onComplete = vi.fn();
    const { container } = render(<BuildClarifyStep idea={KUKI} onComplete={onComplete} onSkip={vi.fn()} />);
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(container.innerHTML).toBe("");
    expect(apiFetch).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith(KUKI);
  });
});

it.each(["My name is Ravi. My bakery is called Blue Fern", 'My name is "Ravi". My bakery is called "Blue Fern"', "My company name is Blue Fern"])("recognizes a business name after a personal introduction: %s", (idea) => {
  expect(ideaGivesName(idea)).toBe(true);
});

it.each(["Build a bakery named after my grandmother for local customers to order cakes", "A dog walking app named for my late dog"])("a relational 'named after/for' is not a name: %s", (idea) => {
  expect(ideaGivesName(idea)).toBe(false);
});

it.each(["A nonprofit called For Good", "A florist called In Bloom", "A studio called By Design"])("a capitalised name that starts with a small word is still a name: %s", (idea) => {
  expect(ideaGivesName(idea)).toBe(true);
});

it("keeps an unresolved approval workflow question instead of treating it as audience", async () => {
  serve([{ id: "approvals", header: "Approvals", text: "Who approves purchase requests?", why: "", choices: [{ id: "manager", label: "Manager" }] }]);
  setup("A purchasing portal called LedgerDesk for teams");
  expect(await screen.findByText("Who approves purchase requests?")).toBeTruthy();
});

it.each(["My first name is Ravi", "My full name is Ravi", "I am called Ravi"])("keeps the name question for the personal introduction %s", (idea) => {
  expect(ideaGivesName(idea)).toBe(false);
  setup(idea);
  expect(screen.getByText(NAME_TEXT)).toBeTruthy();
});

describe("the name question is skipped when the founder names the business they run", () => {
  it.each([
    "I'm Priya Shah and I run Saffron Spoon, a small Indian catering business in Austin.",
    "We own Rise & Shine Bakery in Austin and need a site",
  ])("%s", (idea) => {
    expect(ideaGivesName(idea)).toBe(true);
  });

  it.each([
    "We run Instagram ads for local gyms",
    "I run a small bakery in Pune",
    "I'm Priya Shah, make me a site",
    "We started 2021, and now want a website",
    "I run Shopify, need a site",
    "I run Airbnb in Goa",
    "I run Google Ads at Acme",
    "I opened 2 Cafes in Pune",
  ])("but still asks for %s", (idea) => {
    expect(ideaGivesName(idea)).toBe(false);
  });
});

describe("a detailed brief is never quizzed", () => {
  it("a detailed brief in Hindi counts as detailed", () => {
    expect(ideaIsDetailed("पुणे में क्रम्ब एंड को नाम की एक बेकरी के लिए वेबसाइट बनाओ जो परिवारों को ताज़ा ब्रेड केक और कुकीज़ बेचती है")).toBe(true);
    expect(ideaIsDetailed("एक बेकरी वेबसाइट")).toBe(false);
  });

  const BRIEF =
    "Build a landing page for a neighbourhood bakery caled Crumb & Co. Style: warm, minimal, cream and browncolours, serif headings. Sections: hero with order btton, our breads, opening hours, contact.";

  it("the step mounted on its own (the Home card) hands the brief back unchanged, fetches nothing and never shows a question", async () => {
    serve([{ id: "audience-0", header: "Audience", text: "Who is this app for?", why: "", choices: [{ id: "c", label: "Consumers" }] }]);
    const onComplete = setup(BRIEF);
    await act(async () => {});
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith(BRIEF);
    expect(apiFetch).not.toHaveBeenCalled();
    expect(screen.queryByText(NAME_TEXT)).toBeNull();
    expect(screen.queryByText("Who is this app for?")).toBeNull();
  });

  it("answers typed into an earlier step do not make a short idea count as detailed", () => {
    const onComplete = setup("A bakery website\n\nAdditional context:\n- Audience: Consumers who live nearby and want fresh bread every single morning");
    expect(onComplete).not.toHaveBeenCalled();
    expect(screen.getByText(NAME_TEXT)).toBeTruthy();
  });
});
