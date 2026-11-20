
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { cleanup, render } from "@testing-library/react";
import { useChannelActions } from "./useChannelActions";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body });
const httpError = (status: number) =>
  Promise.resolve({ ok: false, status, json: async () => ({ error: { message: `HTTP ${status}` } }) });
const dropped = () => Promise.reject(new TypeError("Failed to fetch"));

function route(actions: () => Promise<unknown>) {
  apiFetch.mockImplementation((path: string) => {
    if (path.includes("/metrics")) return ok({ metrics: [] });
    return actions();
  });
}

let seen:
  | {
      store: string;
      error: string | null;
      notice: string | null;
      actions: number;
      ids: string[];
      loading: boolean;
      reload: () => void;
      refreshSilent: () => Promise<void>;
      handlers: ReturnType<typeof useChannelActions>["handlers"];
    }
  | null = null;

function Probe() {
  const c = useChannelActions("google_ads");
  seen = {
    store: c.store,
    error: c.error,
    notice: c.notice,
    actions: c.actions.length,
    ids: c.actions.map((a) => a.id),
    loading: c.loading,
    reload: c.reload,
    refreshSilent: c.refreshSilent,
    handlers: c.handlers,
  };
  return <p>{c.store}</p>;
}

async function mount() {
  await act(async () => {
    render(<Probe />);
  });
}

const paths = () => apiFetch.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  apiFetch.mockReset();
  seen = null;
});
afterEach(cleanup);

it("falls back to the decisions store on a 404, as before", async () => {
  route(() => httpError(404));
  await mount();
  expect(seen?.store).toBe("decisions");
  expect(seen?.error).toBeNull();
});

it("does not fall back on a 500, and posts no id to /api/approvals", async () => {
  route(() => httpError(500));
  await mount();
  expect(seen?.store).toBe("unknown");
  expect(seen?.error).toBeTruthy();
  expect(seen?.actions).toBe(0);
  expect(paths().some((p) => p.startsWith("/api/approvals"))).toBe(false);
});

it("does not fall back when the connection drops", async () => {
  route(dropped);
  await mount();
  expect(seen?.store).toBe("unknown");
  expect(seen?.error).toBeTruthy();
  expect(paths().some((p) => p.startsWith("/api/approvals"))).toBe(false);
});

const ROW = (id: string) => ({
  id,
  channel_slug: "google_ads",
  action_type: "text_post",
  title: `Action ${id}`,
  body: {},
  status: "pending",
  position: 1,
  run_of: 1,
  blocking: false,
  impact: 3,
  score: 50,
  proposed_at: "2026-09-20T10:00:00Z",
  source: "channel_action",
  executable: false,
});

const listOf = (...ids: string[]) => ({
  actions: ids.map(ROW),
  more: 0,
  store: "channel_actions",
});

it("refreshes the list without ever flipping loading", async () => {
  route(() => ok(listOf("a")));
  await mount();
  expect(seen?.ids).toEqual(["a"]);

  route(() => ok(listOf("a", "b")));
  await act(async () => {
    await seen?.refreshSilent();
  });

  expect(seen?.ids).toEqual(["a", "b"]);
  expect(seen?.loading).toBe(false);
});

it("a refresh that works clears an earlier load failure", async () => {
  route(() => httpError(500));
  await mount();
  expect(seen?.error).toBeTruthy();

  route(() => ok(listOf("a")));
  await act(async () => {
    await seen?.refreshSilent();
  });

  expect(seen?.ids).toEqual(["a"]);
  expect(seen?.error).toBeNull();
});

it("a failed refresh changes nothing, so the rows on screen stay", async () => {
  route(() => ok(listOf("a")));
  await mount();

  route(() => httpError(500));
  await act(async () => {
    await seen?.refreshSilent();
  });

  expect(seen?.ids).toEqual(["a"]);
  expect(seen?.error).toBeNull();
});

it("an older silent refresh cannot overwrite a newer one when it answers last", async () => {
  route(() => ok(listOf("a")));
  await mount();

  let releaseOld!: () => void;
  const old = new Promise<void>((resolve) => { releaseOld = resolve; });
  let reads = 0;
  route(() => ++reads === 1 ? old.then(() => ok(listOf("old"))) : ok(listOf("new")));

  let first!: Promise<void>;
  await act(async () => { first = seen!.refreshSilent(); });
  await act(async () => { await seen!.refreshSilent(); });
  expect(seen?.ids).toEqual(["new"]);

  await act(async () => {
    releaseOld();
    await first;
  });
  expect(seen?.ids).toEqual(["new"]);
});

it("stands aside while a card is being approved", async () => {
  route(() => ok(listOf("a")));
  await mount();

  let release!: () => void;
  const inFlight = new Promise<void>((r) => {
    release = () => r();
  });
  apiFetch.mockImplementation((path: string) => {
    if (path.includes("/metrics")) return ok({ metrics: [] });
    if (path.includes("/api/channel-actions/")) return inFlight.then(() => ok({}));
    return ok(listOf("a"));
  });

  const before = paths().length;
  let write!: Promise<unknown>;
  await act(async () => {
    write = Promise.resolve(
      seen!.handlers.onSetStatus(ROW("a") as never, "acted"),
    );
  });

  await act(async () => {
    await seen?.refreshSilent();
  });
  expect(paths().filter((p) => p.includes("/actions")).length).toBe(
    paths().slice(0, before).filter((p) => p.includes("/actions")).length,
  );

  apiFetch.mockImplementation((path: string) =>
    path.includes("/metrics") ? ok({ metrics: [] }) : ok(listOf()),
  );
  await act(async () => {
    release();
    await write;
  });
  expect(seen?.ids).toEqual([]);
});

it("a poll answered after a write cannot resurrect the approved card", async () => {
  route(() => ok(listOf("a")));
  await mount();

  let answerPoll!: () => void;
  const stale = new Promise<void>((r) => {
    answerPoll = () => r();
  });
  apiFetch.mockImplementation((path: string) => {
    if (path.includes("/metrics")) return ok({ metrics: [] });
    if (path.includes("/api/channel-actions/")) return ok({});
    return stale.then(() => ok(listOf("a")));
  });

  let poll!: Promise<void>;
  await act(async () => {
    poll = seen!.refreshSilent();
  });

  apiFetch.mockImplementation((path: string) => {
    if (path.includes("/metrics")) return ok({ metrics: [] });
    if (path.includes("/api/channel-actions/")) return ok({});
    return ok(listOf());
  });
  await act(async () => {
    await seen!.handlers.onSetStatus(ROW("a") as never, "acted");
  });
  expect(seen?.ids).toEqual([]);

  await act(async () => {
    answerPoll();
    await poll;
  });
  expect(seen?.ids).toEqual([]);
});

it("never flips a known channel_actions store on a later transient failure", async () => {
  route(() => ok({ actions: [], more: 0, store: "channel_actions" }));
  await mount();
  expect(seen?.store).toBe("channel_actions");

  route(() => httpError(500));
  await act(async () => {
    seen?.reload();
  });
  expect(seen?.store).toBe("channel_actions");
  expect(seen?.error).toBeTruthy();

  route(dropped);
  await act(async () => {
    seen?.reload();
  });
  expect(seen?.store).toBe("channel_actions");
  expect(paths().some((p) => p.startsWith("/api/approvals"))).toBe(false);
});

it("marking a card done or rejecting it shows no note", async () => {
  apiFetch.mockImplementation((path: string) => {
    if (path.includes("/metrics")) return ok({ metrics: [] });
    if (path.includes("/api/channel-actions/")) return ok({});
    return ok(listOf("a", "b"));
  });
  await mount();
  await act(async () => {
    await seen!.handlers.onSetStatus(ROW("a") as never, "acted");
  });
  expect(apiFetch.mock.calls.some((c) => String(c[0]).includes("/api/channel-actions/a"))).toBe(true);
  expect(seen?.notice).toBeNull();
  await act(async () => {
    await seen!.handlers.onSetStatus(ROW("b") as never, "rejected", { note: "not for us" });
  });
  expect(apiFetch.mock.calls.some((c) => String(c[0]).includes("/api/channel-actions/b"))).toBe(true);
  expect(seen?.notice).toBeNull();
});

it("an email card change re-reads the list silently, so the cached rows match the card", async () => {
  route(() => ok(listOf("a")));
  await mount();
  expect(seen?.ids).toEqual(["a"]);
  route(() => ok(listOf("b")));
  await act(async () => {
    seen?.handlers.onEmailCardChanged?.({ id: "a" } as never);
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(seen?.ids).toEqual(["b"]);
  expect(seen?.loading).toBe(false);
});

it("writes the picked page through the top action, with only the card id and topic", async () => {
  route(() => ok(listOf("a")));
  await mount();
  apiFetch.mockImplementation((path: string) => {
    if (path.includes("/metrics")) return ok({ metrics: [] });
    if (path.includes("/top-actions/")) return ok({ run_id: "r1" });
    return ok(listOf("a"));
  });
  let result: unknown;
  await act(async () => {
    result = await seen!.handlers.onWriteProofPage!(ROW("a") as never, 2);
  });
  expect(result).toBe(true);
  const call = apiFetch.mock.calls.find((c) => String(c[0]).includes("/top-actions/"));
  expect(String(call?.[0])).toBe("/api/channels/seo/top-actions/write_proof_page");
  expect(JSON.parse(String((call?.[1] as { body: string }).body)).inputs).toEqual({ card_id: "a", topic: 2 });
});

it("passes the server's reason to the ad edit dialog when a revision is refused", async () => {
  route(() => ok(listOf("a")));
  await mount();
  apiFetch.mockImplementation((path: string) => {
    if (path.includes("/metrics")) return ok({ metrics: [] });
    if (path.includes("/ad-review")) return Promise.resolve({ ok: false, status: 422, json: async () => ({ error: { code: "invalid_changes", message: "The end date must be after the start date." } }) });
    return ok(listOf("a"));
  });
  let failure: unknown;
  await act(async () => {
    await seen!.handlers.onReviseAd!(ROW("a") as never, { revision: "a".repeat(64), changes: { end_time: "2026-11-01" }, request_id: "request-1" }).catch((error: unknown) => { failure = error; });
  });
  expect((failure as Error).message).toBe("The end date must be after the start date.");
});
