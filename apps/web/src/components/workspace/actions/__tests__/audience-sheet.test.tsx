// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const m = vi.hoisted(() => ({ fetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })) }));
vi.mock("@/lib/api", () => ({ apiFetch: m.fetch }));

import { ChannelActionCard } from "../ChannelActionCard";
import { platformFor } from "../platforms";
import { audienceSheet, blankContexts } from "../audienceParse";
import type { ActionHandlers } from "../types";
import { makeAction } from "./fixtures";
import { clearBlankSuggestionCache } from "../blankSuggestions";

const SHEET = [
  "AUDIENCE 1: hearing-care professionals LinkedIn can find by job and industry, a possible referral route (hypothesis, not stated on your site)",
  "Locations:      [fill in: the countries you serve]",
  "Company size:    [fill in: leave open unless you target clinics of a given size]",
  "Industries:     Hospitals and Health Care; Medical Practices",
  "Job functions:   Healthcare Services",
  "Job seniorities: [fill in: the levels who recommend tools to patients]",
  "Job titles:     Audiologist; Hearing Aid Specialist [confirm with LinkedIn's title search]",
  "Exclude:        Current customers (upload list) | Seniority: Entry, Training | Students",
  "Audience Expansion: OFF    LinkedIn Audience Network: OFF",
  "Size: read the estimate Campaign Manager shows. We cannot see it.",
  "",
  "AUDIENCE 2: people who visited your site (retargeting, needs the Insight Tag firing first)",
  "Source:        Website visitors, from the Insight Tag, on the pages of your app",
  "Locations:      [fill in: the countries you serve]",
  "Window:        [fill in: the visit window you want]",
  "Exclude:        People who already signed up (conversion audience once defined)",
  "Audience Expansion: OFF    LinkedIn Audience Network: OFF",
  "Size: read the estimate Campaign Manager shows. We cannot see it.",
].join("\n");

afterEach(() => {
  cleanup();
  clearBlankSuggestionCache();
  m.fetch.mockReset();
  m.fetch.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({}) }));
});

describe("the audience sheet parser", () => {
  it("must catch: two pairs on one line become two rows, and a pipe inside a value does not open a new row", () => {
    const sheet = audienceSheet(SHEET)!;
    expect(sheet.audiences.map((a) => a.n)).toEqual(["1", "2"]);
    const one = sheet.audiences[0];
    expect(one.rows.map((r) => r.key)).toEqual(["Locations", "Company size", "Industries", "Job functions", "Job seniorities", "Job titles", "Exclude", "Audience Expansion", "LinkedIn Audience Network", "Size"]);
    expect(one.rows.find((r) => r.key === "Exclude")?.value).toBe("Current customers (upload list) | Seniority: Entry, Training | Students");
    expect(sheet.audiences[1].text.startsWith("AUDIENCE 2:")).toBe(true);
    expect(sheet.audiences[1].text).not.toContain("AUDIENCE 1");
  });

  it("must catch: audiences lettered A and B get the same sheet, and their blanks name the letter", () => {
    const lettered = [
      "TWO LINKEDIN AUDIENCES TYPED FOR CAMPAIGN MANAGER",
      "",
      "AUDIENCE A: Founders and owners of small companies (proxy: job facets cannot see who lacks a growth team)",
      "Locations: [confirm: countries your signups come from]",
      "Company size: 1-10, 11-50",
      "Job titles: Founder, Co-Founder, Owner",
      "Audience Expansion: OFF",
      "",
      "AUDIENCE B: Website retargeting (Insight Tag, no proxy)",
      "Source: visitors to the site, last 30 days",
      "Audience Expansion: OFF",
      "LinkedIn Audience Network: OFF",
    ].join("\n");
    const sheet = audienceSheet(lettered)!;
    expect(sheet.audiences.map((a) => a.n)).toEqual(["A", "B"]);
    expect(sheet.audiences[0].rows.map((r) => r.key)).toEqual(["Locations", "Company size", "Job titles", "Audience Expansion"]);
    expect(sheet.audiences[1].rows.map((r) => r.key)).toEqual(["Source", "Audience Expansion", "LinkedIn Audience Network"]);
    expect(blankContexts(lettered, ["[confirm: countries your signups come from]"])).toEqual({ "[confirm: countries your signups come from]": "Locations · audience A" });
  });

  it("leaves ordinary text alone", () => {
    expect(audienceSheet("Hi there.\nLocations: anywhere")).toBeNull();
    expect(audienceSheet("AUDIENCE 1: just a line\nno pairs here")).toBeNull();
  });

  it("must catch: each blank is named by its row, and a blank both audiences share says so", () => {
    const ctx = blankContexts(SHEET, ["[fill in: the countries you serve]", "[confirm with LinkedIn's title search]", "[fill in: the visit window you want]"]);
    expect(ctx).toEqual({
      "[fill in: the countries you serve]": "Locations · audiences 1 and 2",
      "[confirm with LinkedIn's title search]": "Job titles · audience 1",
      "[fill in: the visit window you want]": "Window · audience 2",
    });
  });
});

const handlers = (): ActionHandlers => ({ onSetStatus: vi.fn(), onRedo: vi.fn(), onApprove: vi.fn(), onOpenChat: vi.fn() });

const card = (kind: "copy_to_site" | "task" = "task") =>
  makeAction("other", {
    id: "aud-1",
    channel_slug: "linkedin_ads",
    title: "Two audiences to test once tracking works",
    executable: false,
    card_kind: kind,
    primary_label: "Copy",
    done_label: "I did this",
    body: {
      step: {
        title: "Two audiences to test once tracking works",
        body: "Two audiences, ready to type into Campaign Manager.",
        blocking: false,
        effort: "minutes",
        evidence: [],
        deliverable: { kind: "list", label: "Two LinkedIn audiences, typed for Campaign Manager", content: SHEET },
      },
    },
  });

describe("the audience card", () => {
  it("must catch: blanks are typed inside the rows, and one value fills both audiences", () => {
    render(<ChannelActionCard action={card()} platform={platformFor("linkedin_ads")} handlers={handlers()} />);
    expect(screen.queryByTestId("blank-field")).toBeNull();
    expect(screen.queryByTestId("audience-copy")).toBeNull();
    expect(screen.queryByTestId("audience-gaps")).toBeNull();
    const blocks = screen.getAllByTestId("audience-block");
    expect(blocks).toHaveLength(2);
    expect(within(blocks[0]).getByText("Hospitals and Health Care")).toBeTruthy();
    expect(within(blocks[0]).getByText("Hearing-care professionals LinkedIn can find by job and industry, a possible referral route")).toBeTruthy();
    expect(within(blocks[0]).getByText("Hypothesis, not stated on your site")).toBeTruthy();
    expect(within(blocks[0]).getByTestId("audience-toggles").textContent).toBe("Audience ExpansionOffLinkedIn Audience NetworkOff");
    const places = screen.getAllByLabelText("Locations · audiences 1 and 2") as HTMLInputElement[];
    expect(places).toHaveLength(2);
    fireEvent.change(places[0], { target: { value: "United States" } });
    expect((screen.getAllByLabelText("Locations · audiences 1 and 2")[1] as HTMLInputElement).value).toBe("United States");
    fireEvent.change(within(blocks[1]).getByLabelText("Window · audience 2"), { target: { value: "90 days" } });
    const open = screen.getAllByTestId("audience-blank").filter((el) => el.getAttribute("data-filled") === "false") as HTMLInputElement[];
    expect(open.length).toBeGreaterThan(0);
    for (const el of open) fireEvent.change(el, { target: { value: "Senior" } });
    fireEvent.change(within(blocks[1]).getByLabelText("Window · audience 2"), { target: { value: "" } });
  });

  it("a copy card gets the same sheet", () => {
    render(<ChannelActionCard action={card("copy_to_site")} platform={platformFor("linkedin_ads")} handlers={handlers()} />);
    expect(screen.getAllByTestId("audience-block")).toHaveLength(2);
  });
});

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
  });
};

const suggestCalls = () => (m.fetch.mock.calls as unknown as [string, RequestInit?][]).filter(([url]) => String(url).includes("/blank-suggestions"));

const answer = (byIndex: (blanks: string[]) => Record<string, string[]>, ok = true) =>
  m.fetch.mockImplementation((async (url: string, init?: RequestInit) => {
    if (!String(url).includes("/blank-suggestions")) return { ok: true, status: 200, json: async () => ({}) };
    const blanks = (JSON.parse(String(init?.body)) as { blanks: { blank: string }[] }).blanks.map((b) => b.blank);
    return { ok, status: ok ? 200 : 503, json: async () => (ok ? { suggestions: byIndex(blanks) } : { error: { code: "llm_failed" } }) };
  }) as never);

const menuCopy = async (name: RegExp) => {
  fireEvent.click(screen.getByRole("button", { name: "More actions" }));
  fireEvent.click(screen.getByRole("menuitem", { name }));
  await act(async () => {});
};
const place = () => screen.getAllByLabelText("Locations · audiences 1 and 2") as HTMLInputElement[];
const size = () => screen.getByLabelText("Company size · audience 1") as HTMLInputElement;
const win = () => screen.getByLabelText("Window · audience 2") as HTMLInputElement;
const tagOf = (el: HTMLElement) => el.parentElement?.querySelector('[data-testid="audience-suggested"]')?.textContent ?? null;
const dots = () => screen.queryAllByLabelText("To fill").length;
const byBlank = (blanks: string[]) =>
  Object.fromEntries(
    blanks.map((b, i) => [
      String(i),
      b.includes("countries") ? ["United States; Canada", "United States", "Worldwide"] : b.includes("clinics") ? ["11-50; 51-200", "Any size"] : b.includes("visit window") ? ["90 days", "30 days"] : [`best ${i}`, `alt ${i}`],
    ]),
  );

describe("Zavi's suggestion is the value of each open blank", () => {
  let writeText: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  });

  it("must catch: the top answer fills the field, is tagged, drops the To fill dot, and is what Copy copies", async () => {
    answer(byBlank);
    render(<ChannelActionCard action={card()} platform={platformFor("linkedin_ads")} handlers={handlers()} />);
    expect(place()[0].placeholder).toBe("the countries you serve");
    expect(place()[0].value).toBe("");
    expect(dots()).toBeGreaterThan(0);
    expect(screen.queryByTestId("audience-suggested")).toBeNull();
    await flush();
    expect(suggestCalls()).toHaveLength(1);
    const [url, init] = suggestCalls()[0];
    expect(url).toBe("/api/channels/linkedin_ads/actions/aud-1/blank-suggestions");
    const sent = (JSON.parse(String(init?.body)) as { blanks: { blank: string; label?: string }[] }).blanks;
    expect(sent.find((b) => b.blank === "[fill in: the countries you serve]")?.label).toBe("Locations · audiences 1 and 2");
    for (const el of place()) {
      expect(el.value).toBe("United States; Canada");
      expect(el.getAttribute("data-filled")).toBe("true");
      expect(tagOf(el)).toBe("Zavi's suggestion");
    }
    expect(win().value).toBe("90 days");
    const blanks = screen.getAllByTestId("audience-blank") as HTMLInputElement[];
    expect(blanks.every((el) => el.value.trim().length > 0)).toBe(true);
    expect(screen.getAllByTestId("audience-suggested")).toHaveLength(blanks.length);
    expect(dots()).toBe(0);
    expect(screen.queryByTestId("blank-suggestion")).toBeNull();
    await menuCopy(/^Copy$/);
    const copied = String(writeText.mock.calls[writeText.mock.calls.length - 1]?.[0]);
    expect(copied).toContain("Locations:      United States; Canada");
    expect(copied).toContain("Company size:    11-50; 51-200");
    expect(copied).toContain("Window:        90 days");
    expect(copied).not.toMatch(/\[fill in|\[confirm/);
    expect(suggestCalls()).toHaveLength(1);
  });

  it("must catch: a suggestion that lands late never replaces what the founder typed or cleared, and still fills the rest", async () => {
    const gate: { release?: () => void } = {};
    m.fetch.mockImplementation((async (url: string, init?: RequestInit) => {
      if (!String(url).includes("/blank-suggestions")) return { ok: true, status: 200, json: async () => ({}) };
      const blanks = (JSON.parse(String(init?.body)) as { blanks: { blank: string }[] }).blanks.map((b) => b.blank);
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
      return { ok: true, status: 200, json: async () => ({ suggestions: byBlank(blanks) }) };
    }) as never);
    render(<ChannelActionCard action={card()} platform={platformFor("linkedin_ads")} handlers={handlers()} />);
    await flush();
    fireEvent.change(place()[0], { target: { value: "Germany" } });
    fireEvent.change(win(), { target: { value: "x" } });
    fireEvent.change(win(), { target: { value: "" } });
    expect(gate.release).toBeDefined();
    gate.release?.();
    await flush();
    for (const el of place()) {
      expect(el.value).toBe("Germany");
      expect(tagOf(el)).toBeNull();
    }
    expect(win().value).toBe("");
    expect(win().getAttribute("data-filled")).toBe("false");
    expect(tagOf(win())).toBeNull();
    expect(size().value).toBe("11-50; 51-200");
    expect(tagOf(size())).toBe("Zavi's suggestion");
    await menuCopy(/^Copy with blanks/);
    const copied = String(writeText.mock.calls[writeText.mock.calls.length - 1]?.[0]);
    expect(copied).toContain("Locations:      Germany");
    expect(copied).not.toContain("United States; Canada");
    expect(copied).toContain("Window:        [fill in: the visit window you want]");
    expect(copied).not.toContain("90 days");
    expect(copied).toContain("Company size:    11-50; 51-200");
  });

  it("must catch: clearing or editing a suggested field sticks through later renders, and the tag goes with it", async () => {
    answer(byBlank);
    const view = render(<ChannelActionCard action={card()} platform={platformFor("linkedin_ads")} handlers={handlers()} />);
    await flush();
    expect(win().value).toBe("90 days");
    fireEvent.change(win(), { target: { value: "" } });
    fireEvent.change(size(), { target: { value: "201-500" } });
    view.rerender(<ChannelActionCard action={card()} platform={platformFor("linkedin_ads")} handlers={handlers()} />);
    await flush();
    expect(win().value).toBe("");
    expect(win().placeholder).toBe("e.g. 90 days");
    expect(dots()).toBe(0);
    expect(tagOf(win())).toBeNull();
    expect(size().value).toBe("201-500");
    expect(tagOf(size())).toBeNull();
    expect(tagOf(place()[0])).toBe("Zavi's suggestion");
    await menuCopy(/^Copy with blanks/);
    const copied = String(writeText.mock.calls[writeText.mock.calls.length - 1]?.[0]);
    expect(copied).toContain("Window:        [fill in: the visit window you want]");
    expect(copied).toContain("Company size:    201-500");
    expect(suggestCalls()).toHaveLength(1);
  });

  it("must catch: reopening the card does not ask the model again", async () => {
    answer((blanks) => Object.fromEntries(blanks.map((_, i) => [String(i), ["a", "b", "c"]])));
    const first = render(<ChannelActionCard action={card()} platform={platformFor("linkedin_ads")} handlers={handlers()} />);
    await flush();
    first.unmount();
    render(<ChannelActionCard action={card()} platform={platformFor("linkedin_ads")} handlers={handlers()} />);
    await flush();
    expect(suggestCalls()).toHaveLength(1);
    expect(place()[0].value).toBe("a");
  });

  it("must catch: when the model fails each blank keeps its own hint and its To fill dot, stays typeable, and the next open retries", async () => {
    answer(() => ({}), false);
    const first = render(<ChannelActionCard action={card()} platform={platformFor("linkedin_ads")} handlers={handlers()} />);
    await flush();
    expect(place()[0].placeholder).toBe("the countries you serve");
    expect(place()[0].value).toBe("");
    expect(screen.queryByTestId("audience-suggested")).toBeNull();
    expect(dots()).toBeGreaterThan(0);
    fireEvent.change(place()[0], { target: { value: "Germany" } });
    expect(place()[0].value).toBe("Germany");
    first.unmount();
    render(<ChannelActionCard action={card()} platform={platformFor("linkedin_ads")} handlers={handlers()} />);
    await flush();
    expect(suggestCalls()).toHaveLength(2);
  });

  it("a row whose value Zavi marked as its suggestion still parses as one row with no blank", () => {
    const sheet = audienceSheet("AUDIENCE 1: operations leads\nLocations: United States; Canada (Zavi's suggestion)\nCompany size: 51-200 (Zavi's suggestion)")!;
    expect(sheet.audiences[0].rows).toEqual([
      { key: "Locations", value: "United States; Canada (Zavi's suggestion)" },
      { key: "Company size", value: "51-200 (Zavi's suggestion)" },
    ]);
  });
});
