
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getTenantGoogleAuth: vi.fn(),
  findGoogleFiles: vi.fn(),
  getEnabledStreamableServer: vi.fn(),
}));

vi.mock("@/services/connectors/composio/google-token", () => ({
  getTenantGoogleAuth: mocks.getTenantGoogleAuth,
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/services/mcp/discovery", () => ({
  getEnabledStreamableServer: mocks.getEnabledStreamableServer,
}));

import { callWebFetchTool, listWebFetchTools } from "../web_fetch";
import * as core from "../google-drive-core";

const TENANT = "11111111-2222-3333-4444-555555555555";

beforeEach(() => {
  vi.restoreAllMocks();
  mocks.getTenantGoogleAuth.mockReset();
  mocks.getEnabledStreamableServer.mockReset();
});

function parse(content: string) {
  return JSON.parse(content) as Record<string, any>;
}

describe("find_google_docs — advertised surface", () => {
  it("is on the web_fetch server with a query-only input schema", () => {
    const tool = listWebFetchTools().find((t) => t.tool_name === "find_google_docs");
    expect(tool).toBeDefined();
    expect(tool?.server_id).toBe("web_fetch");
    expect(Object.keys(tool!.input_schema.properties as object)).toEqual(["query"]);
    expect(tool?.description).toContain("web_fetch__fetch");
  });
});

describe("find_google_docs — connection states are distinguishable", () => {
  it("no Drive on either rail → not_connected, and says the check did NOT happen", async () => {
    mocks.getTenantGoogleAuth.mockResolvedValue(null);
    mocks.getEnabledStreamableServer.mockResolvedValue(null);

    const res = await callWebFetchTool(TENANT, "find_google_docs", { query: "refund policy" });
    expect(res.is_error).toBe(true);
    const out = parse(res.content);
    expect(out.error).toBe("google_drive_not_connected");
    expect(out.message).toContain("have NOT checked");
  });

  it("Composio is the only Drive rail: a Pipedream Drive is never probed (search or read)", async () => {
    mocks.getTenantGoogleAuth.mockResolvedValue(null);
    mocks.getEnabledStreamableServer.mockResolvedValue({ server_id: "pipedream_google_drive" });

    const find = await callWebFetchTool(TENANT, "find_google_docs", { query: "refund policy" });
    expect(parse(find.content).error).toBe("google_drive_not_connected");
    const read = await callWebFetchTool(TENANT, "fetch", { url: "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit" });
    expect(read.is_error).toBe(true);
    expect(parse(read.content).error).toBe("google_drive_not_connected");
    expect(mocks.getEnabledStreamableServer).not.toHaveBeenCalled();
  });
});

describe("find_google_docs — results", () => {
  const AUTH = { access_token: "tok", account_email: "ops@example.com" };

  it("returns metadata only, with the next step spelled out", async () => {
    mocks.getTenantGoogleAuth.mockResolvedValue(AUTH);
    vi.spyOn(core, "findGoogleFiles").mockResolvedValue({
      status: "ok",
      truncated: false,
      notes: [],
      files: [
        {
          file_id: "doc1",
          name: "Support Templates",
          mime_type: "application/vnd.google-apps.document",
          modified_time: "2026-09-01T00:00:00.000Z",
          web_view_link: "https://docs.google.com/document/d/doc1/edit",
        },
      ],
    });

    const res = await callWebFetchTool(TENANT, "find_google_docs", { query: "non-return" });
    expect(res.is_error).toBe(false);
    const out = parse(res.content);
    expect(out.match_count).toBe(1);
    expect(out.files[0].name).toBe("Support Templates");
    expect(out.next_step).toContain("web_fetch__fetch");
    expect(JSON.stringify(out)).not.toMatch(/"body_text"|"content"/);
  });

  it("forwards the core's truncation markers instead of presenting a capped list as whole", async () => {
    mocks.getTenantGoogleAuth.mockResolvedValue(AUTH);
    vi.spyOn(core, "findGoogleFiles").mockResolvedValue({
      status: "ok",
      truncated: true,
      notes: ["[truncated: showing the 10 most recently modified matches]"],
      files: [],
    });

    const res = await callWebFetchTool(TENANT, "find_google_docs", { query: "policy" });
    const out = parse(res.content);
    expect(out.truncated).toBe(true);
    expect(out.notes[0]).toContain("[truncated:");
  });

  it("zero matches is a real answer, and the envelope says not to invent one", async () => {
    mocks.getTenantGoogleAuth.mockResolvedValue(AUTH);
    vi.spyOn(core, "findGoogleFiles").mockResolvedValue({
      status: "ok",
      truncated: false,
      notes: [],
      files: [],
    });

    const res = await callWebFetchTool(TENANT, "find_google_docs", { query: "nonexistent" });
    expect(res.is_error).toBe(false);
    const out = parse(res.content);
    expect(out.match_count).toBe(0);
    expect(out.next_step).toContain("Do NOT state a policy they have not written");
  });

  it("an INCOMPLETE empty search does not license an absence claim", async () => {
    mocks.getTenantGoogleAuth.mockResolvedValue(AUTH);
    vi.spyOn(core, "findGoogleFiles").mockResolvedValue({
      status: "ok",
      truncated: false,
      notes: [
        "[incomplete: Google could not search every drive this account can reach, so a short or empty result is NOT proof the document is absent]",
      ],
      files: [],
    });

    const res = await callWebFetchTool(TENANT, "find_google_docs", { query: "non-return" });
    const out = parse(res.content);
    expect(out.match_count).toBe(0);
    expect(out.next_step).toContain("did NOT finish");
    expect(out.next_step).toContain("NOT evidence of absence");
    expect(out.next_step).toContain("Do NOT say they have nothing written down");
    expect(out.next_step).not.toContain("That is a real answer");
    expect(out.next_step).not.toMatch(/(?<!Do NOT )say they have nothing written down/);
  });

  it("a TRUNCATED result says the list is not everything they have", async () => {
    mocks.getTenantGoogleAuth.mockResolvedValue(AUTH);
    vi.spyOn(core, "findGoogleFiles").mockResolvedValue({
      status: "ok",
      truncated: true,
      notes: ["[truncated: showing the 10 most recently modified matches]"],
      files: [
        {
          file_id: "doc1",
          name: "Refund Policy",
          mime_type: "application/vnd.google-apps.document",
          modified_time: null,
          web_view_link: "https://docs.google.com/document/d/doc1/edit",
        },
      ],
    });

    const res = await callWebFetchTool(TENANT, "find_google_docs", { query: "policy" });
    const out = parse(res.content);
    expect(out.next_step).toContain("did NOT finish");
    expect(out.next_step).toContain("do not say anything is missing");
  });

  it("the advertised description no longer says an empty result proves absence", () => {
    const tool = listWebFetchTools().find((t) => t.tool_name === "find_google_docs");
    expect(tool?.description).not.toContain(
      "If this returns nothing, say the company has nothing written down",
    );
    expect(tool?.description).toContain("not the same as the company having nothing written down");
  });

  it("a Google 401 through the proxy is a dead grant: one call, reconnect message", async () => {
    mocks.getTenantGoogleAuth.mockResolvedValue(AUTH);
    const spy = vi.spyOn(core, "findGoogleFiles").mockResolvedValue({ status: "auth_stale", message: "stale" });

    const res = await callWebFetchTool(TENANT, "find_google_docs", { query: "policy" });
    expect(res.is_error).toBe(true);
    expect(parse(res.content).error).toBe("google_drive_auth_expired");
    expect(parse(res.content).message).toContain("reconnect Google Drive");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("search and read sign through the tenant's own transport (Composio proxy), not a raw token", async () => {
    const fetchFn = vi.fn();
    mocks.getTenantGoogleAuth.mockResolvedValue({ ...AUTH, fetchFn });
    const find = vi.spyOn(core, "findGoogleFiles").mockResolvedValue({ status: "ok", truncated: false, notes: [], files: [] });
    const read = vi.spyOn(core, "readGoogleFile").mockResolvedValue({ status: "error", message: "stubbed" } as never);
    await callWebFetchTool(TENANT, "find_google_docs", { query: "policy" });
    await callWebFetchTool(TENANT, "fetch", { url: "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit" });
    expect(find.mock.calls[0][2]).toBe(fetchFn);
    expect(read.mock.calls[0][2]).toBe(fetchFn);
  });

  it("rejects a too-short query without touching the connector", async () => {
    const res = await callWebFetchTool(TENANT, "find_google_docs", { query: "x" });
    expect(res.is_error).toBe(true);
    expect(parse(res.content).error).toBe("bad_input");
    expect(mocks.getTenantGoogleAuth).not.toHaveBeenCalled();
  });
});

describe("Google Drive auth is always the REQUESTING tenant's (Composio rail)", () => {
  const OTHER = "99999999-8888-7777-6666-555555555555";
  const AUTH_A = { access_token: "tok_A", account_email: "a@tenant-a.test" };
  const AUTH_B = { access_token: "tok_B", account_email: "b@tenant-b.test" };
  const DOC = "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit";
  const byTenant = async (t: string) => (t === TENANT ? AUTH_A : t === OTHER ? AUTH_B : null);

  it("search resolves auth for the requesting tenant and searches with that tenant's auth", async () => {
    mocks.getTenantGoogleAuth.mockImplementation(byTenant);
    const find = vi.spyOn(core, "findGoogleFiles").mockResolvedValue({ status: "ok", truncated: false, notes: [], files: [] });
    await callWebFetchTool(TENANT, "find_google_docs", { query: "refund policy" });
    expect(mocks.getTenantGoogleAuth.mock.calls.length).toBeGreaterThan(0);
    for (const c of mocks.getTenantGoogleAuth.mock.calls) expect(c[0]).toBe(TENANT);
    expect(find.mock.calls[0][1]).toBe(AUTH_A);
  });

  it("document read resolves auth for the requesting tenant and reads with that tenant's auth", async () => {
    mocks.getTenantGoogleAuth.mockImplementation(byTenant);
    const read = vi.spyOn(core, "readGoogleFile").mockResolvedValue({ status: "error", message: "stubbed" } as never);
    await callWebFetchTool(TENANT, "fetch", { url: DOC });
    expect(mocks.getTenantGoogleAuth.mock.calls.length).toBeGreaterThan(0);
    for (const c of mocks.getTenantGoogleAuth.mock.calls) expect(c[0]).toBe(TENANT);
    expect(read).toHaveBeenCalled();
    expect(read.mock.calls[0][1]).toBe(AUTH_A);
  });

  it("a distinct tenant gets its own auth for search and read, never the first tenant's", async () => {
    mocks.getTenantGoogleAuth.mockImplementation(byTenant);
    const find = vi.spyOn(core, "findGoogleFiles").mockResolvedValue({ status: "ok", truncated: false, notes: [], files: [] });
    const read = vi.spyOn(core, "readGoogleFile").mockResolvedValue({ status: "error", message: "stubbed" } as never);
    await callWebFetchTool(OTHER, "find_google_docs", { query: "refund policy" });
    await callWebFetchTool(OTHER, "fetch", { url: DOC });
    for (const c of mocks.getTenantGoogleAuth.mock.calls) expect(c[0]).toBe(OTHER);
    expect(find.mock.calls[0][1]).toBe(AUTH_B);
    expect(read.mock.calls[0][1]).toBe(AUTH_B);
    expect(JSON.stringify([...find.mock.calls, ...read.mock.calls])).not.toContain("tok_A");
  });
});
