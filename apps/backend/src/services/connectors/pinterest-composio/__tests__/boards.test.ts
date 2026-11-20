import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/connectors/composio/account", () => ({ resolveOwnedComposioAccount: vi.fn() }));
vi.mock("@/services/connectors/composio/api", () => ({ composioExecuteTool: vi.fn() }));
vi.mock("@/services/tenant-client", () => ({ asTenantId: (t: string) => t, tenantRpc: vi.fn(), tenantStorage: () => { throw new Error("storage must be injected"); } }));

import { createPinterestBoard, searchPinterestBoards, type PinterestReadinessDeps } from "../readiness";
import { isRawPinterestWrite } from "../raw-write";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const ACCOUNT = { tenant_id: TENANT, toolkit: "pinterest", connected_account_id: "ca_pin", auth_config_id: "ac" } as never;

type Exec = PinterestReadinessDeps["execute"];
function deps(execute: Exec, account: unknown = ACCOUNT): PinterestReadinessDeps & { execute: ReturnType<typeof vi.fn>; resolveAccount: ReturnType<typeof vi.fn> } {
  return {
    resolveAccount: vi.fn(async () => account),
    execute: vi.fn(execute),
    storageInfo: vi.fn(),
    fetchText: vi.fn(),
    tenantSite: vi.fn(),
    now: () => 1_000_000,
  } as never;
}
const okData = (data: unknown) => async () => ({ ok: true, status: 200, data, error: null, outcome_unknown: false });
const refused = (status: number, error: unknown, data: unknown = null) => async () => ({ ok: false, status, data, error, outcome_unknown: false });

describe("createPinterestBoard", () => {
  it("creates a PUBLIC board on the tenant's own connected account and returns it", async () => {
    const d = deps(okData({ response_data: { id: "9001", name: "Autumn tables", privacy: "PUBLIC" } }));
    const r = await createPinterestBoard(TENANT, { name: "  Autumn tables ", description: " Ideas " }, d);
    expect(r).toEqual({ ok: true, board: { id: "9001", name: "Autumn tables", privacy: "PUBLIC" } });
    expect(d.resolveAccount).toHaveBeenCalledWith(TENANT);
    expect(d.execute).toHaveBeenCalledTimes(1);
    expect(d.execute.mock.calls[0][0]).toEqual({
      tool_slug: "PINTEREST_CREATE_BOARD",
      user_id: TENANT,
      connected_account_id: "ca_pin",
      arguments: { name: "Autumn tables", privacy: "PUBLIC", description: "Ideas" },
    });
  });

  it("never sends a secret privacy and leaves an empty description out", async () => {
    const d = deps(okData({ id: 42, name: "A" }));
    await createPinterestBoard(TENANT, { name: "A", description: "   " }, d);
    expect(d.execute.mock.calls[0][0].arguments).toEqual({ name: "A", privacy: "PUBLIC" });
  });

  it("says not connected and calls nothing when Pinterest is not linked", async () => {
    const d = deps(okData({ id: "1" }), null);
    const r = await createPinterestBoard(TENANT, { name: "A" }, d);
    expect(r).toMatchObject({ ok: false, code: "not_connected" });
    expect(d.execute).not.toHaveBeenCalled();
  });

  it.each([
    [409, "conflict"],
    [400, "You already have a board with this name."],
    [400, { code: 58, message: "Board name already exists" }],
  ])("a name clash (%s) reads as name taken", async (status, error) => {
    const r = await createPinterestBoard(TENANT, { name: "Ideas" }, deps(refused(status, error)));
    expect(r).toMatchObject({ ok: false, code: "name_taken", message: expect.stringContaining("already have a board with that name") });
  });

  it("another refusal says Pinterest refused, with Pinterest's own words", async () => {
    const r = await createPinterestBoard(TENANT, { name: "Ideas" }, deps(refused(403, "Not authorized to access the board.")));
    expect(r).toEqual({ ok: false, code: "refused", message: "Pinterest refused to make this board. Pinterest said: Not authorized to access the board." });
  });

  it.each([
    ["a 5xx", async () => ({ ok: false, status: 502, data: null, error: "bad gateway", outcome_unknown: true })],
    ["a transport error", async () => ({ ok: false, status: 0, data: null, error: "composio_transport_error", outcome_unknown: true })],
    ["a throw", async () => { throw new Error("boom"); }],
    ["a success with no id", okData({ name: "Ideas" })],
  ])("%s is unconfirmed, never a refusal the founder would retry into a duplicate", async (_label, exec) => {
    const r = await createPinterestBoard(TENANT, { name: "Ideas" }, deps(exec as Exec));
    expect(r).toMatchObject({ ok: false, code: "unconfirmed", message: expect.stringContaining("Reload your boards") });
  });

  it("keeps the agent refusal on the raw Pinterest board write", () => {
    expect(isRawPinterestWrite("PINTEREST_CREATE_BOARD")).toBe(true);
  });
});

describe("searchPinterestBoards", () => {
  it("asks Pinterest for the tenant's boards matching the name and reads the items", async () => {
    const d = deps(okData({ data: { items: [{ id: "77", name: "Linen ideas", privacy: "PUBLIC" }, { id: 78, name: "Private", privacy: "SECRET" }, { name: "no id" }], bookmark: null } }));
    const r = await searchPinterestBoards(TENANT, "  linen ", d);
    expect(d.execute.mock.calls[0][0]).toEqual({
      tool_slug: "PINTEREST_SEARCH_OWN_CONTENT",
      user_id: TENANT,
      connected_account_id: "ca_pin",
      arguments: { resource_type: "boards", query: "linen", page_size: 25 },
    });
    expect(r).toEqual({
      ok: true,
      complete: true,
      boards: [
        { id: "77", name: "Linen ideas", privacy: "PUBLIC" },
        { id: "78", name: "Private", privacy: "SECRET" },
      ],
    });
  });

  it("says not connected without calling Pinterest", async () => {
    const d = deps(okData({ items: [] }), null);
    expect(await searchPinterestBoards(TENANT, "x", d)).toEqual({ ok: false, code: "pinterest_not_connected" });
    expect(d.execute).not.toHaveBeenCalled();
  });

  it("a refusal or an unreadable answer is a failed lookup, never an empty result", async () => {
    expect(await searchPinterestBoards(TENANT, "x", deps(refused(400, "bad")))).toEqual({ ok: false, code: "pinterest_lookup_failed" });
    expect(await searchPinterestBoards(TENANT, "x", deps(okData({ message: "weird" })))).toEqual({ ok: false, code: "pinterest_lookup_failed" });
  });
});
