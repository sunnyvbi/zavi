// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

const calls: Array<{ path: string; method?: string; body?: unknown }> = [];
type Route = { status?: number; body?: unknown; pending?: Promise<void> };
let routes: Record<string, Route | ((body: unknown) => Route)> = {};
const apiFetch = vi.fn(async (path: string, opts?: { method?: string; body?: string }) => {
  const body = opts?.body ? JSON.parse(opts.body) : undefined;
  calls.push({ path, method: opts?.method, body });
  const r = routes[`${opts?.method ?? "GET"} ${path}`];
  const hit = typeof r === "function" ? r(body) : r ?? {};
  if (hit.pending) await hit.pending;
  const status = hit.status ?? 200;
  return { ok: status < 400, status, json: async () => hit.body ?? {} } as unknown as Response;
});
vi.mock("@/fonts", () => ({ inter: { variable: "font-inter-var" } }));
vi.mock("@/lib/api", () => ({ apiFetch: (p: string, o?: { method?: string; body?: string }) => apiFetch(p, o) }));

let importFiles: unknown[] | null = [];
let importFailures = 0;
const setAfterRead = vi.fn();
vi.mock("./SetupProvider", () => ({
  useSetupOn: () => null,
  useSetupOptional: () => ({ imports: { files: importFiles, refresh: async () => {}, failures: importFailures }, setAfterRead }),
}));

vi.mock("./importReads", async (orig) => ({ ...(await orig<typeof import("./importReads")>()), IMPORT_POLL_MS: 20 }));

import { SetupPolishStep } from "./SetupPolishStep";
import { fileFromServer } from "./importReadState";

const fileRow = (extraction: unknown) =>
  fileFromServer({ id: "11111111-1111-1111-1111-111111111111", filename: "zavi-context.md", created_at: new Date(Date.now() - 5_000).toISOString(), extraction });

const facts = {
  facts: [
    { key: "company_name", value_text: "Apna" },
    { key: "domain", value_text: "https://apna.com" },
    { key: "what_we_sell", value_text: "Tutoring" },
    { key: "competitors", value_text: "Preply, $99/mo" },
  ],
};

beforeEach(() => {
  calls.length = 0;
  importFiles = [];
  importFailures = 0;
  setAfterRead.mockClear();
  routes = { "GET /api/connectors/company-facts": { body: facts } };
});
afterEach(cleanup);

const finishButton = () => screen.getByRole("button", { name: /let’s grow/ }) as HTMLButtonElement;

describe("SetupPolishStep", () => {
  it("Finish waits for the prefill read to settle, and a failed read warns but does not block", async () => {
    let release!: () => void;
    routes["GET /api/connectors/company-facts"] = { status: 500, pending: new Promise<void>((r) => { release = r; }) };
    render(<SetupPolishStep onFinish={async () => {}} />);
    await waitFor(() => expect(calls.some((c) => c.path === "/api/connectors/company-facts")).toBe(true));
    expect(finishButton().disabled).toBe(true);
    release();
    await waitFor(() => expect(finishButton().disabled).toBe(false));
    expect(screen.getByText(/Some of your details didn.t load/)).toBeTruthy();
  });

  it("has no Brand section: no tone, no colours, and finishing writes neither", async () => {
    const onFinish = vi.fn(async () => {});
    render(<SetupPolishStep onFinish={onFinish} />);
    await waitFor(() => expect(finishButton().disabled).toBe(false));
    expect(screen.queryByText("Brand")).toBeNull();
    expect(screen.queryByText("How should you sound?")).toBeNull();
    expect(screen.queryByText("Brand colours")).toBeNull();
    fireEvent.click(finishButton());
    await waitFor(() => expect(onFinish).toHaveBeenCalledWith([]));
    expect(calls.some((c) => c.path === "/api/workspace/brand-kit")).toBe(false);
  });

  it("POSTs each displayed field on its own, even unchanged ones", async () => {
    const onFinish = vi.fn(async () => {});
    render(<SetupPolishStep onFinish={onFinish} />);
    await waitFor(() => expect(finishButton().disabled).toBe(false));
    fireEvent.click(finishButton());
    await waitFor(() => expect(onFinish).toHaveBeenCalledWith([]));
    const posts = calls.filter((c) => c.method === "POST" && c.path === "/api/connectors/company-facts");
    expect(posts.map((p) => (p.body as { facts: unknown[] }).facts.length)).toEqual([1, 1, 1, 1]);
    expect(posts.map((p) => (p.body as { facts: Array<{ key: string }> }).facts[0].key)).toEqual(["company_name", "domain", "what_we_sell", "competitors"]);
  });

  it("names exactly the details that didn't save", async () => {
    routes["POST /api/connectors/company-facts"] = (body) => {
      const key = (body as { facts: Array<{ key: string }> }).facts[0].key;
      if (key === "domain") return { status: 500, body: { error: { code: "write_failed" } } };
      if (key === "competitors") return { body: { ok: true, rejected: [{ key, dropped: ["$99/mo"] }] } };
      return { body: { ok: true } };
    };
    const onFinish = vi.fn(async () => {});
    render(<SetupPolishStep onFinish={onFinish} />);
    await waitFor(() => expect(finishButton().disabled).toBe(false));
    fireEvent.click(finishButton());
    await waitFor(() => expect(onFinish).toHaveBeenCalledWith(["website", "some competitors"]));
  });

  it("when a read lands: untouched fields take the file's value (tagged), an edited one keeps the founder's text and shows the file's", async () => {
    importFiles = [fileRow({ state: "reading", claim_id: "c" })];
    const { rerender } = render(<SetupPolishStep onFinish={async () => {}} />);
    await waitFor(() => expect(finishButton().disabled).toBe(false));
    expect(screen.getByText(/I'm still reading zavi-context.md/)).toBeTruthy();
    expect(screen.queryByText("Your file may update this.")).toBeNull();

    const name = screen.getByDisplayValue("Apna") as HTMLInputElement;
    name.focus();
    fireEvent.change(name, { target: { value: "Apna Tutor" } });

    routes["GET /api/connectors/company-facts"] = {
      body: {
        facts: [
          { key: "company_name", value_text: "Apna Learning" },
          { key: "domain", value_text: "https://apna.com" },
          { key: "what_we_sell", value_text: "1:1 heritage language tutoring" },
          { key: "competitors", value_text: "Preply, $99/mo" },
        ],
      },
    };
    importFiles = [fileRow({ state: "read", facts: 12, redactions: 0 })];
    rerender(<SetupPolishStep onFinish={async () => {}} />);

    await screen.findByDisplayValue("1:1 heritage language tutoring");
    expect(screen.getByText("From zavi-context.md")).toBeTruthy();
    expect(screen.getByDisplayValue("Apna Tutor")).toBeTruthy();
    expect(screen.getByText(`zavi-context.md says "Apna Learning". You changed this, so I kept yours.`)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByDisplayValue("Apna Tutor"));

    fireEvent.click(screen.getByRole("button", { name: "Use the file's line" }));
    expect(screen.getByDisplayValue("Apna Learning")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use website guess instead" }));
    expect(screen.getByDisplayValue("Tutoring")).toBeTruthy();
  });

  it("Keep mine dismisses the file's suggestion and keeps the typed value", async () => {
    importFiles = [fileRow(null)];
    const { rerender } = render(<SetupPolishStep onFinish={async () => {}} />);
    await waitFor(() => expect(finishButton().disabled).toBe(false));
    fireEvent.change(screen.getByDisplayValue("Tutoring"), { target: { value: "Online tutoring" } });
    routes["GET /api/connectors/company-facts"] = { body: { facts: [...facts.facts.filter((f) => f.key !== "what_we_sell"), { key: "what_we_sell", value_text: "Tutors for NRI kids" }] } };
    importFiles = [fileRow({ state: "read", facts: 3, redactions: 0 })];
    rerender(<SetupPolishStep onFinish={async () => {}} />);
    await screen.findByText(/says "Tutors for NRI kids"/);
    fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));
    expect(screen.queryByText(/says "Tutors for NRI kids"/)).toBeNull();
    expect(screen.getByDisplayValue("Online tutoring")).toBeTruthy();
  });

  it("finishing while a read is open leaves the untouched file fields to the file (not saved as the founder's) and tells the Growth page", async () => {
    importFiles = [fileRow({ state: "reading", claim_id: "c" })];
    const onFinish = vi.fn(async () => {});
    render(<SetupPolishStep onFinish={onFinish} />);
    await waitFor(() => expect(finishButton().disabled).toBe(false));
    fireEvent.change(screen.getByDisplayValue("Tutoring"), { target: { value: "Online tutoring" } });
    fireEvent.click(finishButton());
    await waitFor(() => expect(onFinish).toHaveBeenCalled());
    const keys = calls.filter((c) => c.method === "POST" && c.path === "/api/connectors/company-facts").map((p) => (p.body as { facts: Array<{ key: string }> }).facts[0].key);
    expect(keys).toEqual(["domain", "what_we_sell"]);
    expect(setAfterRead).toHaveBeenCalledWith({
      files: ["11111111-1111-1111-1111-111111111111"],
      untouched: [
        { key: "company_name", label: "Company name", value: "Apna" },
        { key: "competitors", label: "Competitors", value: "Preply, $99/mo" },
      ],
    });
    expect(setAfterRead.mock.invocationCallOrder[0]).toBeLessThan(onFinish.mock.invocationCallOrder[0]);
  });

  it("Finish waits for the first imports answer (a read in flight must not look absent)", async () => {
    importFiles = null;
    const { rerender } = render(<SetupPolishStep onFinish={async () => {}} />);
    await waitFor(() => expect(calls.length).toBe(1));
    expect(finishButton().disabled).toBe(true);
    importFiles = [];
    rerender(<SetupPolishStep onFinish={async () => {}} />);
    await waitFor(() => expect(finishButton().disabled).toBe(false));
  });

  it("a landed read whose facts refetch fails is retried, and Finish waits until it applies", async () => {
    importFiles = [fileRow({ state: "reading", claim_id: "c" })];
    const { rerender } = render(<SetupPolishStep onFinish={async () => {}} />);
    await waitFor(() => expect(finishButton().disabled).toBe(false));
    const factsGets = () => calls.filter((c) => !c.method && c.path === "/api/connectors/company-facts").length;
    routes["GET /api/connectors/company-facts"] = { status: 500 };
    importFiles = [fileRow({ state: "read", facts: 3, redactions: 0 })];
    rerender(<SetupPolishStep onFinish={async () => {}} />);
    await waitFor(() => expect(factsGets()).toBe(2));
    expect(finishButton().disabled).toBe(true);
    expect(screen.getByDisplayValue("Tutoring")).toBeTruthy();
    routes["GET /api/connectors/company-facts"] = { body: { facts: [...facts.facts.filter((f) => f.key !== "what_we_sell"), { key: "what_we_sell", value_text: "Tutors for NRI kids" }] } };
    await screen.findByDisplayValue("Tutors for NRI kids");
    expect(factsGets()).toBeGreaterThanOrEqual(3);
    await waitFor(() => expect(finishButton().disabled).toBe(false));
  });

  it("the first company-facts read failed: a landed file still applies, and the load warning goes", async () => {
    routes["GET /api/connectors/company-facts"] = { status: 500 };
    importFiles = [fileRow({ state: "reading", claim_id: "c" })];
    const { rerender } = render(<SetupPolishStep onFinish={async () => {}} />);
    await screen.findByText(/Some of your details didn.t load/);
    routes["GET /api/connectors/company-facts"] = { body: facts };
    importFiles = [fileRow({ state: "read", facts: 3, redactions: 0 })];
    rerender(<SetupPolishStep onFinish={async () => {}} />);
    await screen.findByDisplayValue("Tutoring");
    expect(screen.getByDisplayValue("https://apna.com")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(/Some of your details didn.t load/)).toBeNull());
    expect(finishButton().disabled).toBe(false);
  });

  it("the imports list keeps failing: after 3 tries Finish opens with one plain line", async () => {
    importFiles = null;
    importFailures = 2;
    const { rerender } = render(<SetupPolishStep onFinish={async () => {}} />);
    await waitFor(() => expect(calls.length).toBe(1));
    expect(finishButton().disabled).toBe(true);
    importFailures = 3;
    rerender(<SetupPolishStep onFinish={async () => {}} />);
    await waitFor(() => expect(finishButton().disabled).toBe(false));
    expect(screen.getByText("I couldn't load your file's details. You can finish now and fix them later in Company Details.")).toBeTruthy();
  });

  it("after giving up on the file's details, Finish saves only what the founder typed, never the untouched guesses", async () => {
    importFiles = null;
    importFailures = 3;
    const onFinish = vi.fn(async () => {});
    render(<SetupPolishStep onFinish={onFinish} />);
    await waitFor(() => expect(finishButton().disabled).toBe(false));
    fireEvent.change(screen.getByDisplayValue("Tutoring"), { target: { value: "Online tutoring" } });
    fireEvent.click(finishButton());
    await waitFor(() => expect(onFinish).toHaveBeenCalled());
    const keys = calls.filter((c) => c.method === "POST" && c.path === "/api/connectors/company-facts").map((p) => (p.body as { facts: Array<{ key: string }> }).facts[0].key);
    expect(keys).toEqual(["domain", "what_we_sell"]);
  });

  it("a landed file's facts keep failing: after 3 tries Finish opens, and a later success still applies", async () => {
    importFiles = [fileRow({ state: "reading", claim_id: "c" })];
    const { rerender } = render(<SetupPolishStep onFinish={async () => {}} />);
    await waitFor(() => expect(finishButton().disabled).toBe(false));
    routes["GET /api/connectors/company-facts"] = { status: 500 };
    importFiles = [fileRow({ state: "read", facts: 3, redactions: 0 })];
    rerender(<SetupPolishStep onFinish={async () => {}} />);
    await screen.findByText("I couldn't load your file's details. You can finish now and fix them later in Company Details.");
    expect(finishButton().disabled).toBe(false);
    routes["GET /api/connectors/company-facts"] = { body: { facts: [...facts.facts.filter((f) => f.key !== "what_we_sell"), { key: "what_we_sell", value_text: "Tutors for NRI kids" }] } };
    await screen.findByDisplayValue("Tutors for NRI kids");
    expect(screen.queryByText(/I couldn't load your file's details/)).toBeNull();
  });

  describe("competitors for an idea with no website", () => {
    const ideaFacts = { facts: [{ key: "company_name", value_text: "SFrent" }, { key: "what_we_sell", value_text: "Peer-to-peer car rental in SF" }] };
    const SUGGEST = "POST /api/connectors/company-facts/competitor-suggestions";

    it("finds competitors, shows them for review, and saves what the founder keeps", async () => {
      routes["GET /api/connectors/company-facts"] = { body: ideaFacts };
      routes[SUGGEST] = { body: { competitors: ["Turo", "Getaround"], pending: false } };
      const onFinish = vi.fn(async () => {});
      render(<SetupPolishStep onFinish={onFinish} />);
      expect(await screen.findByText("Turo")).toBeTruthy();
      expect(screen.getByText("Getaround")).toBeTruthy();
      expect(screen.getByText(/I found these from what you told me/)).toBeTruthy();
      expect(screen.getByText(/I filled in what your idea told me/)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Remove Getaround" }));
      fireEvent.click(finishButton());
      await waitFor(() => expect(onFinish).toHaveBeenCalled());
      const saved = calls.find((c) => c.method === "POST" && c.path === "/api/connectors/company-facts" && (c.body as { facts: Array<{ key: string }> }).facts[0].key === "competitors");
      expect((saved?.body as { facts: unknown[] }).facts).toEqual([{ key: "competitors", value: "Turo" }]);
    });

    it("shows it is searching, joins a research still running, and keeps a name typed meanwhile", async () => {
      routes["GET /api/connectors/company-facts"] = { body: ideaFacts };
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      let asked = 0;
      routes[SUGGEST] = () => (++asked === 1 ? { body: { competitors: [], pending: true }, pending: gate } : { body: { competitors: ["Turo"], pending: false } });
      render(<SetupPolishStep onFinish={async () => {}} />);
      expect(await screen.findByText("Finding competitors…")).toBeTruthy();
      expect(finishButton().disabled).toBe(false);
      fireEvent.change(screen.getByLabelText("Add a competitor"), { target: { value: "Zipcar" } });
      fireEvent.submit(screen.getByLabelText("Add a competitor").closest("form")!);
      release();
      expect(await screen.findByText("Turo")).toBeTruthy();
      expect(screen.getByText("Zipcar")).toBeTruthy();
      expect(asked).toBe(2);
      expect(screen.queryByText("Finding competitors…")).toBeNull();
    });

    it("says so when nothing was found, and never asks when competitors are already set", async () => {
      routes["GET /api/connectors/company-facts"] = { body: ideaFacts };
      routes[SUGGEST] = { body: { competitors: [], pending: false } };
      render(<SetupPolishStep onFinish={async () => {}} />);
      expect(await screen.findByText(/I couldn't find any yet/)).toBeTruthy();
      cleanup();
      calls.length = 0;
      routes["GET /api/connectors/company-facts"] = { body: facts };
      render(<SetupPolishStep onFinish={async () => {}} />);
      await waitFor(() => expect(finishButton().disabled).toBe(false));
      expect(calls.some((c) => c.path.endsWith("competitor-suggestions"))).toBe(false);
    });
  });
});
