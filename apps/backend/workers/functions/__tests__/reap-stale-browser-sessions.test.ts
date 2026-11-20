
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

interface FakeRow {
  id: string;
  engine: string;
  status: string;
  provider_session_id: string | null;
  opened_at: string;
}
const h = vi.hoisted(() => {
  const fakeTable: FakeRow[] = [];
  return {
    fakeTable,
    deleteAnchorSessionById: vi.fn(async (_k: string, _id: string) => true),
    closeBrowserSession: vi.fn(async ({ session_id }: { session_id: string }) => {
      const r = fakeTable.find((x) => x.id === session_id && x.status === "open");
      if (r) r.status = "closed";
    }),
  };
});
const fakeTable = h.fakeTable;
const deleteAnchorSessionById = h.deleteAnchorSessionById;

vi.mock("../../client", () => ({
  inngest: {
    createFunction: (_cfg: unknown, _trig: unknown, handler: unknown) => ({
      handler,
    }),
  },
}));

vi.mock("@/services/sandbox/browser-mcp/anchor-rest-client", () => ({
  deleteAnchorSessionById: h.deleteAnchorSessionById,
  createRestAnchorClient: vi.fn(() => ({})),
}));

vi.mock("@/services/sandbox/browser-mcp/browser-sessions", () => ({
  closeBrowserSession: h.closeBrowserSession,
  openBrowserSession: vi.fn(),
  setBrowserSessionProviderId: vi.fn(),
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: vi.fn(() => ({
    from: (_t: string) => ({
      select: (_c: string) => ({
        eq: (_c1: string, _v1: string) => ({
          eq: (_c2: string, _v2: string) => ({
            lt: (_c3: string, _v3: string) => ({
              limit: async (_n: number) => ({
                data: h.fakeTable
                  .filter((r) => r.status === "open" && r.engine === "anchor")
                  .map((r) => ({
                    id: r.id,
                    provider_session_id: r.provider_session_id,
                  })),
                error: null,
              }),
            }),
          }),
        }),
      }),
    }),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  })),
}));

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));

import { reapStaleBrowserSessionsFn } from "../reap-stale-browser-sessions";
import {
  anchorBackend,
  _setAnchorClient,
  _setBrowserSessionTracker,
  _resetAnchorSessionCache,
  type BrowserSessionTracker,
} from "@/services/sandbox/browser-mcp/anchor-backend";
import type { BrowserToolCtx, DaemonOp } from "@/services/sandbox/browser-mcp/types";

const CTX: BrowserToolCtx = {
  tenant_id: "t1",
  run_id: "run-elp-1",
  agent_slug: "qa",
  repo_full_name: "x/y",
};
const NAV: DaemonOp = { op: "nav", url: "https://instagram.com/login" };

function fakeTracker(): BrowserSessionTracker {
  return {
    open: vi.fn(async () => {
      const id = "db-row-1";
      fakeTable.push({
        id,
        engine: "anchor",
        status: "open",
        provider_session_id: null,
        opened_at: new Date(Date.now() - 90 * 60_000).toISOString(),
      });
      return id;
    }),
    setProviderId: vi.fn(async ({ session_id, provider_session_id }) => {
      const r = fakeTable.find((x) => x.id === session_id);
      if (r && r.status === "open" && r.provider_session_id === null) {
        r.provider_session_id = provider_session_id;
      }
    }),
    close: vi.fn(async () => {}),
  };
}

let prevKey: string | undefined;
beforeEach(() => {
  prevKey = process.env.ANCHOR_API_KEY;
  process.env.ANCHOR_API_KEY = "test-key";
  fakeTable.length = 0;
  deleteAnchorSessionById.mockClear();
  _resetAnchorSessionCache();
  _setBrowserSessionTracker(fakeTracker());
});
afterEach(() => {
  if (prevKey === undefined) delete process.env.ANCHOR_API_KEY;
  else process.env.ANCHOR_API_KEY = prevKey;
  _setAnchorClient(null);
  _setBrowserSessionTracker(null);
  _resetAnchorSessionCache();
});

describe("ELP slice-1: leaked Anchor session lifecycle → reapable", () => {
  it("stamps the provider id on open, then the reaper deletes the remote session by it + closes the row", async () => {
    const createSession = vi.fn(async () => ({
      id: "anchor-xyz-1",
      cdp_url: "wss://anchor/x",
    }));
    _setAnchorClient({
      createSession,
      runAction: vi.fn(async () => ({ ok: true as const })),
      closeSession: vi.fn(async () => {}),
    });

    const r = await anchorBackend.runOp(CTX, NAV);
    expect(r.ok).toBe(true);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(fakeTable).toHaveLength(1);
    expect(fakeTable[0].provider_session_id).toBe("anchor-xyz-1");
    expect(fakeTable[0].status).toBe("open");

    _resetAnchorSessionCache();

    const handler = (reapStaleBrowserSessionsFn as unknown as {
      handler: (arg: { logger: { error: (m: string) => void } }) => Promise<{
        ok: boolean;
        removed: number;
      }>;
    }).handler;
    const out = await handler({ logger: { error: vi.fn() } });

    expect(deleteAnchorSessionById).toHaveBeenCalledTimes(1);
    expect(deleteAnchorSessionById).toHaveBeenCalledWith("test-key", "anchor-xyz-1");
    expect(fakeTable[0].status).toBe("closed");
    expect(out).toMatchObject({ ok: true, removed: 1 });
  });

  it("REGRESSION GUARD — without the stamp the reaper cannot delete the remote session", async () => {
    fakeTable.push({
      id: "db-row-unstamped",
      engine: "anchor",
      status: "open",
      provider_session_id: null,
      opened_at: new Date(Date.now() - 90 * 60_000).toISOString(),
    });

    const handler = (reapStaleBrowserSessionsFn as unknown as {
      handler: (arg: { logger: { error: (m: string) => void } }) => Promise<{
        ok: boolean;
        removed: number;
      }>;
    }).handler;
    const out = await handler({ logger: { error: vi.fn() } });

    expect(deleteAnchorSessionById).not.toHaveBeenCalled();
    expect(fakeTable[0].status).toBe("closed");
    expect(out).toMatchObject({ ok: true, removed: 1 });
  });
});
