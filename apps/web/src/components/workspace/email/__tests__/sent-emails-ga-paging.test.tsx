// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const routes: Record<string, { status: number; body: unknown }> = {};
const holds: Record<string, Promise<void>> = {};
vi.mock("@/lib/api", () => ({
  apiFetch: async (url: string) => {
    const gate = holds[`GET ${url}`];
    if (gate) await gate;
    const r = routes[`GET ${url}`] ?? { status: 200, body: {} };
    return { ok: r.status < 400, status: r.status, json: () => Promise.resolve(r.body) };
  },
}));
const ga = vi.hoisted(() => ({ connect: vi.fn(async () => undefined) }));
vi.mock("@/app/connectors/GoogleAnalyticsConnectButton", () => ({ startGoogleAnalyticsConnect: ga.connect }));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));
const press = vi.hoisted(() => ({ fn: vi.fn(), state: { busy: false, fired: false, blocked: false, error: null as string | null, credit: null } }));
vi.mock("../../layout/useChannelRunPress", async (load) => ({
  ...(await load<typeof import("../../layout/useChannelRunPress")>()),
  useChannelRunPress: () => ({ press: press.fn, ...press.state }),
}));

import { SentEmailsBlock } from "../SentEmailsBlock";
import { ActionsEmpty, ChannelRunWhileCardsWait, StaleSignupBanner, type ChannelRunInfo } from "../../layout/ChannelEmptyStates";
import { ChannelChatProvider } from "../../actions/channelChat";
import { announceEmailCardChanged } from "@/lib/workspace/emailCardEvents";
import type { SentEmail } from "@/lib/workspace/emailResultsApi";

const cell = (value: number | null, why: string | null = null, action?: "connect_ga") => ({ value, why, ...(action ? { action } : {}) });
const NEEDS_GA = () => cell(null, "Connect Google Analytics", "connect_ga");
const DUE = () => cell(null, "Due Nov 9");
let seq = 0;
const row = (over: Partial<SentEmail> = {}): SentEmail => {
  seq += 1;
  return {
    card: { rail: "channel_actions", id: `card-${seq}`, link: "" },
    route: "sendgrid",
    sent_with: "SendGrid",
    subject: `Email ${seq}`,
    list_name: "Newsletter",
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    spanned: false,
    stage: "d7",
    people: { sent: 10, total: null, stopped: false },
    as_of: "d7",
    delivered: cell(10),
    opens: cell(5),
    opens_label: "Opens",
    clicks: cell(1),
    unsubscribes: cell(0),
    visitors: cell(3),
    win_line: { text: "", metric: "visitors", threshold: 0.02, basis: "median" },
    verdict: "beat",
    verdict_text: "",
    d7_due_at: null,
    note: null,
    ...over,
  } as SentEmail;
};
const many = (count: number, over: Partial<SentEmail> = {}) => Array.from({ length: count }, (_, k) => row({ subject: `Send ${k + 1}`, ...over }));
const serve = (emails: SentEmail[]) => {
  routes["GET /api/email-results"] = { status: 200, body: { emails, more: false } };
};
const connectors = (...slugs: string[]) => {
  routes["GET /api/connectors"] = { status: 200, body: { connectors: slugs.map((slug) => ({ slug })) } };
};
const scheduled = (angle: string) => ({
  id: `plan-${(seq += 1)}`, route: "mailchimp", list_id: "L", list_name: "Lapsed", planned_at: new Date().toISOString(), planned_label: "", timezone: "UTC",
  angle, why: null, source: "email_agent", status: "scheduled", status_reason: null, reason: null, content_version: 1, schedule_gen: 1, card: null, vetoed: false, scheduled: null, unattended: false, sent_at: null,
});
const plan = (items: unknown[] = []) => {
  routes["GET /api/workspace/email-plan"] = { status: 200, body: { ok: true, role: "owner", timezone: "UTC", next_plan_at: null, next_plan_label: null, autopilot_on: null, items, holds: [], released: [] } };
};
const headers = () => screen.getAllByRole("columnheader").map((h) => h.textContent);
const connectBtn = () => screen.queryByRole("button", { name: "Connect Google Analytics" });
const tiles = () => Array.from(screen.getByTestId("stat-strip").children).map((el) => el.getAttribute("data-testid"));
const range = () => screen.getByTestId("campaign-pager-range").textContent;
const next = () => fireEvent.click(within(screen.getByTestId("campaign-pager")).getByRole("button", { name: "Next" }));
const prev = () => fireEvent.click(within(screen.getByTestId("campaign-pager")).getByRole("button", { name: "Previous" }));
const pickRange = (value: string) => fireEvent.change(screen.getByRole("combobox", { name: "Date range" }), { target: { value } });
const rowNames = () => screen.getAllByTestId("row-sent").map((tr) => within(tr).getByRole("link").textContent);
const openFilter = () => {
  const el = screen.getByTestId("campaign-filter") as HTMLDetailsElement;
  el.open = true;
  return el;
};
const reread = async (emails: SentEmail[], settled: () => void) => {
  serve(emails);
  await act(async () => {
    announceEmailCardChanged({ rail: "channel_actions", id: "x", source: "test" });
  });
  await waitFor(settled);
};
const slotted = async () => {
  await screen.findByTestId("sent-emails-actions");
  return within(screen.getByTestId("sent-emails-actions")).findByTestId("run-channel");
};
const gridClasses = () => screen.getByTestId("stat-strip").className.split(/\s+/);

beforeEach(() => {
  for (const k of Object.keys(routes)) delete routes[k];
  for (const k of Object.keys(holds)) delete holds[k];
  ga.connect.mockClear();
  press.fn.mockClear();
  press.state.fired = false;
  press.state.error = null;
  plan();
  connectors("google_analytics");
});
afterEach(cleanup);

describe("Google Analytics decides what the block shows", () => {
  it("not connected: no tile, no column, no zero anywhere, the button sits in the filter row, and four tiles fill the row", async () => {
    connectors("slack", "mailchimp");
    serve([row({ visitors: NEEDS_GA() }), row({ visitors: cell(0) })]);
    plan([scheduled("Win back")]);
    render(<SentEmailsBlock />);
    await waitFor(() => expect(connectBtn()).not.toBeNull());
    expect(tiles()).toEqual(["stat-people", "stat-open", "stat-click", "stat-cto"]);
    expect(screen.queryByText("Site visits")).toBeNull();
    expect(headers()).toEqual(["Campaign", "Status", "Emailed", "Open rate", "Click rate"]);
    for (const tr of [...screen.getAllByTestId("row-sent"), screen.getByTestId("row-scheduled")]) {
      const width = [...tr.querySelectorAll("td")].reduce((n, td) => n + td.colSpan, 0);
      expect(width).toBe(5);
    }
    expect(gridClasses()).toContain("[@container(min-width:600px)]:grid-cols-4");
    expect(gridClasses().some((c) => c.endsWith("grid-cols-5") || c.endsWith("grid-cols-3"))).toBe(false);
    expect(screen.getByTestId("sent-emails-actions").contains(connectBtn())).toBe(true);
    expect(screen.getByTestId("stat-strip").contains(connectBtn())).toBe(false);
    expect(screen.getByTestId("sent-emails-actions").className.split(/\s+/)).toContain("ml-auto");
  });

  it("connected: tile, column and fifth grid step appear and the button is gone", async () => {
    serve([row({ visitors: cell(0) }), row({ visitors: cell(7) })]);
    render(<SentEmailsBlock />);
    await screen.findByTestId("stat-visits");
    expect(tiles()).toEqual(["stat-people", "stat-open", "stat-click", "stat-visits", "stat-cto"]);
    expect(screen.getByTestId("stat-visits-value").textContent).toBe("7");
    expect(headers()).toContain("Site visits");
    expect(gridClasses()).toContain("[@container(min-width:840px)]:grid-cols-5");
    expect(connectBtn()).toBeNull();
    expect(screen.getAllByTestId("row-sent")[0].querySelectorAll("td")).toHaveLength(6);
  });

  it("a first week with no day-7 numbers still offers the button: the rows carry no connect flag yet, so only the connection read can tell", async () => {
    connectors();
    serve([row({ visitors: DUE() }), row({ visitors: DUE() })]);
    render(<SentEmailsBlock />);
    await waitFor(() => expect(connectBtn()).not.toBeNull());
    expect(screen.queryByTestId("stat-visits")).toBeNull();
  });

  it("a Google sign-in with no property picked is not connected: only the row the picker writes counts", async () => {
    connectors("composio.google_analytics");
    serve([row({ visitors: DUE() })]);
    render(<SentEmailsBlock />);
    await waitFor(() => expect(connectBtn()).not.toBeNull());
    expect(screen.queryByTestId("stat-visits")).toBeNull();
  });

  it("connected after a row was read without it: that row says No visits, not 0, a dash or a stale Connect hint", async () => {
    serve([row({ subject: "Stale", visitors: NEEDS_GA() }), row({ subject: "Known", visitors: cell(4) })]);
    render(<SentEmailsBlock />);
    await screen.findByTestId("stat-visits");
    const stale = screen.getAllByTestId("row-sent")[0];
    const last = stale.querySelectorAll("td")[5];
    expect(last.textContent).toBe("No visits");
    expect(within(last as HTMLElement).queryByTestId("missing")).toBeNull();
    expect(last.innerHTML).not.toContain("Connect Google Analytics");
    expect(screen.getByTestId("stat-visits-value").textContent).toBe("4");
  });

  it("flips mid-session when the founder comes back to the tab after connecting", async () => {
    connectors();
    serve([row({ visitors: NEEDS_GA() })]);
    render(<SentEmailsBlock />);
    await waitFor(() => expect(connectBtn()).not.toBeNull());
    connectors("google_analytics");
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await screen.findByTestId("stat-visits");
    expect(connectBtn()).toBeNull();
    expect(headers()).toContain("Site visits");
  });

  it("a failed connection read falls back to what the rows prove, and never claims either way without proof", async () => {
    routes["GET /api/connectors"] = { status: 500, body: {} };
    serve([row({ visitors: NEEDS_GA() }), row({ visitors: cell(9) })]);
    render(<SentEmailsBlock />);
    await waitFor(() => expect(connectBtn()).not.toBeNull());
    expect(screen.queryByTestId("stat-visits")).toBeNull();
    cleanup();

    serve([row({ visitors: cell(9) })]);
    render(<SentEmailsBlock />);
    await screen.findByTestId("stat-visits");
    expect(connectBtn()).toBeNull();
    cleanup();

    serve([row({ visitors: DUE() })]);
    render(<SentEmailsBlock />);
    await screen.findByTestId("stat-strip");
    expect(connectBtn()).toBeNull();
    expect(screen.queryByTestId("stat-visits")).toBeNull();
    expect(headers()).not.toContain("Site visits");
  });

  it("a later failed read keeps the last known answer instead of hiding a working tile", async () => {
    serve([row({ visitors: DUE() })]);
    render(<SentEmailsBlock />);
    await screen.findByTestId("stat-visits");
    routes["GET /api/connectors"] = { status: 500, body: {} };
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(screen.getByTestId("stat-visits")).toBeTruthy();
  });

  it("rows landing before a slow connection read show neither answer until it arrives", async () => {
    let release = () => {};
    holds["GET /api/connectors"] = new Promise((r) => (release = r));
    connectors();
    serve([row({ visitors: DUE() })]);
    render(<SentEmailsBlock />);
    await screen.findByTestId("stat-strip");
    expect(connectBtn()).toBeNull();
    expect(screen.queryByTestId("stat-visits")).toBeNull();
    await act(async () => release());
    await waitFor(() => expect(connectBtn()).not.toBeNull());
  });

  it("the button keeps the connect flow, once per press", async () => {
    connectors();
    serve([row({ visitors: NEEDS_GA() })]);
    render(<SentEmailsBlock />);
    await waitFor(() => expect(connectBtn()).not.toBeNull());
    fireEvent.click(connectBtn() as HTMLElement);
    await waitFor(() => expect(ga.connect).toHaveBeenCalledTimes(1));
  });

  it("Click-to-open needs no GA: it stays with its real value", async () => {
    connectors();
    serve([row({ opens: cell(50), clicks: cell(10), visitors: NEEDS_GA() })]);
    render(<SentEmailsBlock />);
    await waitFor(() => expect(connectBtn()).not.toBeNull());
    expect(screen.getByTestId("stat-cto-value").textContent).toBe("20.0%");
  });
});

describe("campaign table paging", () => {
  it("exactly ten rows: no pager and every row on screen", async () => {
    serve(many(10));
    render(<SentEmailsBlock />);
    await screen.findByRole("link", { name: "Send 10" });
    expect(screen.queryByTestId("campaign-pager")).toBeNull();
    expect(screen.getAllByTestId("row-sent")).toHaveLength(10);
  });

  it("eleven rows: ten on page one, the eleventh alone on page two", async () => {
    serve(many(11));
    render(<SentEmailsBlock />);
    await screen.findByRole("link", { name: "Send 1" });
    expect(range()).toBe("1–10 of 11");
    expect(screen.getAllByTestId("row-sent")).toHaveLength(10);
    next();
    expect(range()).toBe("11 of 11");
    expect(rowNames()).toEqual(["Send 11"]);
  });

  it("the date filter sends the table back to page one", async () => {
    serve(many(23));
    render(<SentEmailsBlock />);
    await screen.findByRole("link", { name: "Send 1" });
    next();
    next();
    expect(range()).toBe("21–23 of 23");
    pickRange("30");
    expect(range()).toBe("1–10 of 23");
    expect(rowNames()[0]).toBe("Send 1");
  });

  it("each campaign filter control sends the table back to page one", async () => {
    serve(many(23));
    render(<SentEmailsBlock />);
    await screen.findByRole("link", { name: "Send 1" });
    next();
    openFilter();
    fireEvent.click(screen.getByRole("checkbox", { name: /Send 1\b/ }) );
    expect(range()).toBe("1–10 of 22");
    next();
    fireEvent.click(screen.getByRole("checkbox", { name: "Count every sent campaign" }));
    expect(range()).toBe("1–10 of 23");
  });

  it("tiles count every row in the filter while page two shows only a few, and follow the filter, never the page", async () => {
    serve(many(23));
    render(<SentEmailsBlock />);
    await screen.findByRole("link", { name: "Send 1" });
    const totalsNow = () => ["stat-people", "stat-visits"].map((id) => screen.getByTestId(`${id}-value`).textContent);
    expect(totalsNow()).toEqual(["230", "69"]);
    next();
    next();
    expect(screen.getAllByTestId("row-sent")).toHaveLength(3);
    expect(totalsNow()).toEqual(["230", "69"]);
    expect(screen.getByTestId("stat-people-sub").textContent).toBe("23 campaigns");
  });

  it("a list that shrinks below the page lands on the last real page, and growing again does not jump back", async () => {
    serve(many(23));
    render(<SentEmailsBlock />);
    await screen.findByRole("link", { name: "Send 1" });
    next();
    next();
    await reread(many(11), () => expect(range()).toBe("11 of 11"));
    expect(rowNames()).toEqual(["Send 11"]);
    prev();
    expect(range()).toBe("1–10 of 11");
    next();
    await reread(many(3), () => expect(screen.getAllByTestId("row-sent")).toHaveLength(3));
    expect(screen.queryByTestId("campaign-pager")).toBeNull();
    await reread(many(23), () => expect(screen.getByTestId("campaign-pager")).toBeTruthy());
    expect(range()).toBe("1–10 of 23");
  });
});

describe("the channel Run button moves to the filter row", () => {
  const run = (slug = "email_marketing"): ChannelRunInfo => ({ slug, name: "Email campaigns", switched: false, priorCount: 0, foldBelow: false, onRan: () => {} });
  const page = (lane: React.ReactNode) => (
    <>
      <SentEmailsBlock />
      <div data-testid="lane">{lane}</div>
    </>
  );

  it("sits beside Connect, after it, once, and a press still runs the channel", async () => {
    connectors();
    serve(many(2, { visitors: NEEDS_GA() }));
    render(page(<ChannelRunWhileCardsWait run={run()} running={false} />));
    await waitFor(() => expect(connectBtn()).not.toBeNull());
    const button = await screen.findByTestId("run-channel");
    const box = screen.getByTestId("sent-emails-actions");
    expect(box.contains(button)).toBe(true);
    expect(screen.getAllByTestId("run-channel")).toHaveLength(1);
    expect(screen.getByTestId("lane").textContent).toBe("");
    expect(connectBtn()?.compareDocumentPosition(button)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(button.textContent).toBe("Run Email campaigns now");
    fireEvent.click(button);
    expect(press.fn).toHaveBeenCalledTimes(1);
  });

  it("keeps its order when Connect arrives after the button has already landed", async () => {
    let release = () => {};
    holds["GET /api/connectors"] = new Promise((r) => (release = r));
    connectors();
    serve(many(2, { visitors: DUE() }));
    render(page(<ChannelRunWhileCardsWait run={run()} running={false} />));
    const button = await slotted();
    await act(async () => release());
    await waitFor(() => expect(connectBtn()).not.toBeNull());
    expect(connectBtn()?.compareDocumentPosition(button)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("shows a failed press beside the button, not far below the table", async () => {
    press.state.error = "Could not start the run.";
    serve(many(2));
    render(page(<ChannelRunWhileCardsWait run={run()} running={false} />));
    await slotted();
    const alert = screen.getByRole("alert");
    expect(screen.getByTestId("sent-emails-actions").contains(alert)).toBe(true);
    expect(alert.textContent).toBe("Could not start the run.");
  });

  it("from the empty state the button moves and the chat door stays in the lane", async () => {
    serve(many(2));
    render(<ChannelChatProvider open={() => {}}>{page(<ActionsEmpty workState="idle" lastRunAt={null} run={run()} quietRun hideCost />)}</ChannelChatProvider>);
    const button = await slotted();
    expect(button.textContent).toBe("Get suggestions");
    expect(within(screen.getByTestId("lane")).queryByTestId("run-channel")).toBeNull();
    expect(within(screen.getByTestId("lane")).getByTestId("ask-about-channel")).toBeTruthy();
    expect(within(screen.getByTestId("sent-emails-actions")).queryByTestId("ask-about-channel")).toBeNull();
  });

  it("with nothing sent there is no filter row, so it stays where it was", async () => {
    serve([]);
    render(page(<ChannelRunWhileCardsWait run={run()} running={false} />));
    await screen.findByTestId("sent-emails-empty");
    expect(screen.getByTestId("lane").contains(screen.getByTestId("run-channel"))).toBe(true);
  });

  it("returns to its place if the block goes away, and leaves other buttons alone", async () => {
    serve(many(2));
    const { rerender } = render(page(<ChannelRunWhileCardsWait run={run()} running={false} />));
    await waitFor(() => expect(screen.getByTestId("sent-emails-actions").contains(screen.getByTestId("run-channel"))).toBe(true));
    rerender(<div data-testid="lane"><ChannelRunWhileCardsWait run={run()} running={false} /></div>);
    await waitFor(() => expect(screen.getByTestId("lane").contains(screen.getByTestId("run-channel"))).toBe(true));
    cleanup();

    render(page(<><ChannelRunWhileCardsWait run={run("seo")} running={false} /><StaleSignupBanner run={run()} weeks={2} /></>));
    await screen.findByTestId("stat-strip");
    const buttons = screen.getAllByTestId("run-channel");
    expect(buttons).toHaveLength(2);
    for (const b of buttons) expect(screen.getByTestId("lane").contains(b)).toBe(true);
  });
});

describe("the loading state", () => {
  it("renders while the results are held and while Google Analytics is unknown, then gives way", async () => {
    let release: () => void = () => undefined;
    holds["GET /api/email-results"] = new Promise<void>((r) => (release = r));
    let releaseGa: () => void = () => undefined;
    holds["GET /api/connectors"] = new Promise<void>((r) => (releaseGa = r));
    serve(many(2));
    render(<SentEmailsBlock />);
    const loading = await screen.findByTestId("sent-emails-loading");
    expect(within(loading).getAllByTestId("sent-emails-loading-stat")).toHaveLength(5);
    await act(async () => release());
    await waitFor(() => expect(screen.queryByTestId("sent-emails-loading")).toBeNull());
    expect(screen.getByTestId("stat-strip")).toBeTruthy();
    await act(async () => releaseGa());
    delete holds["GET /api/email-results"];
    delete holds["GET /api/connectors"];
  });
});

