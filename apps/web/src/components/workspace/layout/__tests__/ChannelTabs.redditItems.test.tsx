// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ChannelSettingsTab } from "../ChannelTabs";
import { PLATFORMS } from "../../actions/platforms";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

type Row = { id?: string; item: string; item_type?: string | null; status?: string; origin?: string; note?: string | null };
type Reply = { ok: boolean; status: number; body: unknown };

const flush = async (ticks = 20) => {
  await act(async () => {
    for (let i = 0; i < ticks; i += 1) await Promise.resolve();
  });
};
const reply = ({ ok, status, body }: Reply) => Promise.resolve({ ok, status, json: async () => body, clone() { return this; } });
const kw = (item: string, extra: Partial<Row> = {}): Row => ({ item, item_type: "problem", status: "tracking", origin: "custom", ...extra });

let server: Record<string, Row[]>;
let onPost: (path: string, body: unknown) => Reply;

beforeEach(() => {
  apiFetch.mockReset();
  server = { keywords: [kw("acme crm", { note: "your own brand" })], competitors: [kw("Hubspot")], communities: [] };
  onPost = () => ({ ok: true, status: 200, body: {} });
  apiFetch.mockImplementation((path: string, init?: RequestInit) => {
    if (init?.method === "PUT") return reply({ ok: true, status: 200, body: {} });
    if (init?.method === "POST") return reply(onPost(String(path), init.body ? JSON.parse(String(init.body)) : undefined));
    return reply({ ok: true, status: 200, body: { fields: server } });
  });
});
afterEach(cleanup);

const mount = () => render(<ChannelSettingsTab slug="reddit_organic" fields={PLATFORMS.reddit_organic.settings ?? []} />);
const sectionFor = (label: string) => screen.getByText(label, { selector: "h4" }).closest("section") as HTMLElement;
const posts = (path?: string) =>
  apiFetch.mock.calls
    .filter(([p, init]) => (init as RequestInit | undefined)?.method === "POST" && (!path || String(p) === path))
    .map(([p, init]) => ({ path: String(p), body: (init as RequestInit).body ? JSON.parse(String((init as RequestInit).body)) : undefined }));
const puts = () => apiFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "PUT");
const type = (label: string, value: string) => {
  const input = within(sectionFor(label)).getByPlaceholderText(new RegExp(`Add to ${label}`, "i"));
  fireEvent.change(input, { target: { value } });
  return input as HTMLInputElement;
};
const add = async (label: string, value: string) => {
  type(label, value);
  fireEvent.click(within(sectionFor(label)).getByRole("button", { name: "Add" }));
  await flush();
};

describe("a Reddit keyword or competitor saves the moment it is added", () => {
  it("posts a keyword as { term } to the keywords route and shows the server's copy", async () => {
    onPost = (path, body) => {
      if (path === "/api/reddit/workspace/keywords") server = { ...server, keywords: [...server.keywords, kw((body as { term: string }).term, { id: "k9" })] };
      return { ok: true, status: 200, body: {} };
    };
    mount();
    await flush();
    await add("Keywords", "crm for startups");

    expect(posts()).toEqual([{ path: "/api/reddit/workspace/keywords", body: { term: "crm for startups" } }]);
    expect(puts()).toHaveLength(0);
    const keywords = sectionFor("Keywords");
    expect(within(keywords).getByText("crm for startups")).toBeTruthy();
    expect(within(keywords).getByText("Added.")).toBeTruthy();
    expect((within(keywords).getByPlaceholderText(/Add to keywords/i) as HTMLInputElement).value).toBe("");
    expect(screen.queryByText("You have unsaved changes.")).toBeNull();
    expect((screen.getByRole("button", { name: "Save settings" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("posts a competitor as { name } to the competitors route", async () => {
    mount();
    await flush();
    await add("Competitors", "Pipedrive");
    expect(posts()).toEqual([{ path: "/api/reddit/workspace/competitors", body: { name: "Pipedrive" } }]);
    expect(puts()).toHaveLength(0);
  });

  it("submits on Enter, not only on the button", async () => {
    mount();
    await flush();
    const input = type("Keywords", "crm on enter");
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await flush();
    expect(posts("/api/reddit/workspace/keywords")).toEqual([{ path: "/api/reddit/workspace/keywords", body: { term: "crm on enter" } }]);
  });

  it("says Already saved and spends no request on a term that is already tracked", async () => {
    mount();
    await flush();
    await add("Keywords", "  ACME CRM ");
    expect(posts()).toHaveLength(0);
    expect(within(sectionFor("Keywords")).getByText("Already saved.")).toBeTruthy();
    expect(within(sectionFor("Keywords")).getAllByText("acme crm")).toHaveLength(1);
  });

  it.each<[string, Reply, string]>([
    ["409 already_exists", { ok: false, status: 409, body: { error: "already_exists" } }, "Already saved."],
    ["409 with a reason", { ok: false, status: 409, body: { error: "limit", message: "You can track up to 25 keywords." } }, "You can track up to 25 keywords."],
    ["403 member", { ok: false, status: 403, body: {} }, "Only an owner or an admin can change this."],
    ["403 with a reason", { ok: false, status: 403, body: { message: "Reddit needs the Starter plan ($20/mo)." } }, "Reddit needs the Starter plan ($20/mo)."],
    ["400", { ok: false, status: 400, body: {} }, "That doesn't look right. Check the value and try again."],
    ["500", { ok: false, status: 500, body: {} }, "Couldn't save that. Try again in a moment."],
  ])("a refused add (%s) says why, keeps the typed term, and never claims Added", async (_name, refusal, line) => {
    onPost = () => refusal;
    mount();
    await flush();
    await add("Keywords", "new term");
    const keywords = sectionFor("Keywords");
    expect(within(keywords).getByRole("status").textContent).toBe(line);
    expect(within(keywords).queryByText("Added.")).toBeNull();
    expect((within(keywords).getByPlaceholderText(/Add to keywords/i) as HTMLInputElement).value).toBe("new term");
    expect(within(keywords).queryByText("new term", { selector: "li *" })).toBeNull();
  });

  it("disables Add while the add is in flight so a double press posts once", async () => {
    let release!: () => void;
    apiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (init?.method === "POST") return new Promise((resolve) => { release = () => resolve({ ok: true, status: 200, json: async () => ({}) }); });
      return reply({ ok: true, status: 200, body: { fields: server } });
    });
    mount();
    await flush();
    type("Keywords", "slow term");
    const button = within(sectionFor("Keywords")).getByRole("button", { name: "Add" }) as HTMLButtonElement;
    fireEvent.click(button);
    await flush();
    expect(button.disabled).toBe(true);
    fireEvent.submit(button.closest("form") as HTMLFormElement);
    await flush();
    expect(posts()).toHaveLength(1);
    await act(async () => release());
    await flush();
  });

  it("keeps an unsaved community edit when a keyword add reloads the list", async () => {
    mount();
    await flush();
    await add("Communities", "r/startups");
    await add("Keywords", "crm for startups");
    expect(within(sectionFor("Communities")).getByText(/startups/)).toBeTruthy();
    expect(screen.getByText("You have unsaved changes.")).toBeTruthy();
  });
});

describe("a community is checked before it is added", () => {
  it.each(["not a sub!", "r/a", "https://example.com/r/sales"])("refuses %j with the example, and adds nothing", async (bad) => {
    mount();
    await flush();
    await add("Communities", bad);
    expect(within(sectionFor("Communities")).getByRole("status").textContent).toBe("Enter a community like r/smallbusiness.");
    expect(screen.queryByText("You have unsaved changes.")).toBeNull();
    expect(posts()).toHaveLength(0);
  });

  it("clears the warning as soon as the founder types again", async () => {
    mount();
    await flush();
    await add("Communities", "bad sub!");
    type("Communities", "r/sales");
    expect(within(sectionFor("Communities")).queryByRole("status")).toBeNull();
  });

  it.each(["r/smallbusiness", "smallbusiness", "https://www.reddit.com/r/smallbusiness/"])("accepts %j onto the Save path", async (good) => {
    mount();
    await flush();
    await add("Communities", good);
    expect(within(sectionFor("Communities")).queryByText("Enter a community like r/smallbusiness.")).toBeNull();
    expect(screen.getByText("You have unsaved changes.")).toBeTruthy();
    expect(posts()).toHaveLength(0);
  });
});

describe("Suggest says what happened", () => {
  const press = async () => {
    fireEvent.click(within(sectionFor("Keywords")).getByRole("button", { name: "Suggest" }));
    await flush();
  };

  it("says nothing new when the server counted zero additions", async () => {
    onPost = () => ({ ok: true, status: 200, body: { keywords_added: 0, competitors_added: 0 } });
    mount();
    await flush();
    await press();
    expect(screen.getByText("Nothing new to suggest right now.")).toBeTruthy();
    expect(screen.queryByText(/Zavi added what it found/)).toBeNull();
  });

  it("says Zavi added rows when the server counted any", async () => {
    onPost = () => ({ ok: true, status: 200, body: { keywords_added: 0, competitors_added: 2 } });
    mount();
    await flush();
    await press();
    expect(screen.getByText("Zavi added what it found. Suggested rows are marked.")).toBeTruthy();
  });

  it("shows the server's reason on a refusal", async () => {
    onPost = () => ({ ok: false, status: 429, body: { error: { code: "rate_limited", message: "Suggest ran a minute ago. Try again shortly." } } });
    mount();
    await flush();
    await press();
    expect(screen.getByText("Suggest ran a minute ago. Try again shortly.")).toBeTruthy();
    expect(screen.queryByText(/Zavi added what it found/)).toBeNull();
  });

  it("falls back to the generic line on a refusal with no reason", async () => {
    onPost = () => ({ ok: false, status: 502, body: null });
    mount();
    await flush();
    await press();
    expect(screen.getByText("Zavi couldn't draft suggestions right now. Try again in a minute.")).toBeTruthy();
  });
});

describe("a tracked row prints its note", () => {
  it("shows the note under the row it belongs to", async () => {
    mount();
    await flush();
    const row = within(sectionFor("Keywords")).getByText("acme crm").closest("li") as HTMLElement;
    expect(within(row).getByText("your own brand")).toBeTruthy();
  });
});

describe("the per-item routes are Reddit's alone", () => {
  it("keeps another channel's list on the Save path", async () => {
    server = {};
    render(<ChannelSettingsTab slug="google_ads" fields={PLATFORMS.google_ads.settings ?? []} />);
    await flush();
    fireEvent.change(screen.getByLabelText("Add to Negative keywords"), { target: { value: "free crm" } });
    fireEvent.click(within(sectionFor("Negative keywords")).getByRole("button", { name: "Add" }));
    await flush();
    expect(posts()).toHaveLength(0);
    expect(screen.getByText("You have unsaved changes.")).toBeTruthy();
  });
});

describe("the retired Post without asking switch", () => {
  it("is gone from the Reddit settings tab and sends nothing for it", async () => {
    mount();
    await flush();
    expect(screen.queryByText("Post without asking")).toBeNull();
    expect((PLATFORMS.reddit_organic.settings ?? []).some((f) => f.id === "autopost")).toBe(false);
    expect(apiFetch.mock.calls.some(([p]) => String(p).includes("autopost"))).toBe(false);
  });
});
