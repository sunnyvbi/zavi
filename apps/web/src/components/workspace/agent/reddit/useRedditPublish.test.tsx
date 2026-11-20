import { Profiler } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "@/lib/api";
import { approveDecision } from "@/lib/approvals/approveDecision";
import {
  publishToReddit, RedditApprovalRequired, RedditDeliveryUnconfirmed, redditPostItem,
  redditPublishKey, redditReplyItem,
} from "./publish";
import { publishRedditAction } from "./redditPublishCoordinator";
import { resetRedditPublishStates, useRedditPublish } from "./useRedditPublish";

type Receipt = { status: string; last_error: string | null };
type Decision = { status: string; body: { channel: string; payload: Record<string, unknown> } };
const data = vi.hoisted(() => ({
  receipts: new Map<string, Receipt>(), decisions: new Map<string, Decision>(),
  next: 0, tenant: "tenant-one", readError: false,
}));
vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/approvals/approveDecision", () => ({ approveDecision: vi.fn() }));
vi.mock("@/app/connectors/connectStrategies", () => ({ startRailConnect: vi.fn() }));
vi.mock("@/lib/active-tenant-client", () => ({ getActiveTenantId: async () => data.tenant }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({
  from: (table: string) => {
    let id = "";
    let tenant = "";
    const query = {
      select: () => query,
      eq: (column: string, value: string) => {
        if (column === "tenant_id") tenant = value;
        else id = value;
        return query;
      },
      maybeSingle: async () => ({
        data: tenant === data.tenant ? (table === "social_posts" ? data.receipts.get(id) : data.decisions.get(id)) ?? null : null,
        error: data.readError ? new Error("read failed") : null,
      }),
    };
    return query;
  },
}) }));

const reply = () => redditReplyItem("card-one", "https://www.reddit.com/r/saas/comments/abc/title/", "Helpful reply.");
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const stageCalls = () => vi.mocked(apiFetch).mock.calls.filter(([path]) => path === "/api/social/propose");

beforeEach(() => {
  resetRedditPublishStates();
  data.receipts.clear();
  data.decisions.clear();
  data.next = 0;
  data.tenant = "tenant-one";
  data.readError = false;
  vi.mocked(apiFetch).mockReset().mockImplementation(async (path, options) => {
    if (path !== "/api/social/propose") return response({ drafts: [], drafts_ok: true });
    const body = JSON.parse(String(options?.body)) as Decision["body"];
    const id = `decision-${++data.next}`;
    data.decisions.set(id, { status: "proposed", body });
    return response({ decision_id: id });
  });
  vi.mocked(approveDecision).mockReset().mockImplementation(async (id) => {
    const decision = data.decisions.get(id);
    if (decision) decision.status = "approved";
    data.receipts.set(id, { status: "published", last_error: null });
    return response({ ok: true });
  });
});
afterEach(async () => {
  cleanup();
  (await import("./redditPublishStore")).resetRedditPublishStates();
  resetRedditPublishStates();
  vi.restoreAllMocks();
});

describe("shared Reddit submissions", () => {
  it("does not post a reply again from a refused card after another card posted the same reply", async () => {
    const url = "https://www.reddit.com/r/saas/comments/abc/title/";
    const cardA = redditReplyItem("card-a", url, "Same reply.");
    const cardB = redditReplyItem("card-b", url, "Same reply.");
    vi.mocked(approveDecision).mockImplementationOnce(async (id) => {
      data.receipts.set(id, { status: "failed", last_error: "vendor_rejected" });
      return response({ ok: true });
    });
    await expect(publishRedditAction(cardA, { text: "Same reply." })).rejects.toThrow(/Reddit refused it/);
    await expect(publishRedditAction(cardB, { text: "Same reply." })).resolves.toMatchObject({ status: "published" });
    expect(stageCalls()).toHaveLength(1);
    await expect(publishRedditAction(cardA, { text: "Same reply." })).resolves.toMatchObject({ status: "published", decisionId: "decision-1" });
    expect(stageCalls()).toHaveLength(1);
  });
  it("retains the accepted decision when its approval response is lost", async () => {
    vi.mocked(approveDecision).mockImplementationOnce(async (id) => {
      data.decisions.get(id)!.status = "approved";
      data.receipts.set(id, { status: "published", last_error: null });
      throw new TypeError("Failed to fetch");
    });
    const item = reply();
    const view = renderHook(() => useRedditPublish(redditPublishKey(item), true));
    await act(async () => { await view.result.current.publish(item, "Helpful reply."); });
    expect(view.result.current.state).toMatchObject({ status: "unconfirmed", decisionId: "decision-1" });
    await act(async () => { await view.result.current.publish(item, "Helpful reply."); });
    expect(view.result.current.state.status).toBe("posted");
    expect(stageCalls()).toHaveLength(1);
    expect(approveDecision).toHaveBeenCalledTimes(1);
  });

  it("retries an approval that never reached the server using the same proposal", async () => {
    vi.mocked(approveDecision).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const item = reply();
    await expect(publishRedditAction(item, { text: "Helpful reply." }, { ownProposal: false })).rejects.toBeInstanceOf(RedditDeliveryUnconfirmed);
    await expect(publishRedditAction(item, { text: "Helpful reply." })).rejects.toBeInstanceOf(RedditApprovalRequired);
    expect(approveDecision).toHaveBeenCalledTimes(1);
    await expect(publishRedditAction(item, { text: "Helpful reply." })).resolves.toMatchObject({ decisionId: "decision-1", status: "published" });
    expect(stageCalls()).toHaveLength(1);
    expect(vi.mocked(approveDecision).mock.calls.map(([id]) => id)).toEqual(["decision-1", "decision-1"]);
  });

  it("does not restage a failed receipt whose vendor outcome is uncertain", async () => {
    vi.mocked(approveDecision).mockImplementationOnce(async (id) => {
      data.decisions.get(id)!.status = "approved";
      data.receipts.set(id, { status: "failed", last_error: "transient_exhausted" });
      return response({ ok: true });
    });
    const item = reply();
    await expect(publishRedditAction(item, { text: "Helpful reply." }, { ownProposal: false })).rejects.toBeInstanceOf(RedditDeliveryUnconfirmed);
    await expect(publishToReddit(item, { text: "Helpful reply." }, false)).rejects.toBeInstanceOf(RedditDeliveryUnconfirmed);
    expect(stageCalls()).toHaveLength(1);
    expect(approveDecision).toHaveBeenCalledTimes(1);
  });

  it("coordinates the hook and the compatibility publisher during delivery", async () => {
    let finish: (() => void) | undefined;
    vi.mocked(approveDecision).mockImplementationOnce((id) => new Promise((resolve) => {
      finish = () => {
        data.receipts.set(id, { status: "published", last_error: null });
        resolve(response({ ok: true }));
      };
    }));
    const item = reply();
    const first = publishRedditAction(item, { text: "Helpful reply." }, { ownProposal: false });
    await waitFor(() => expect(approveDecision).toHaveBeenCalledTimes(1));
    const second = publishToReddit(item, { text: "Helpful reply." }, false);
    finish?.();
    await expect(first).resolves.toMatchObject({ status: "published" });
    await expect(second).resolves.toBe(true);
    expect(stageCalls()).toHaveLength(1);
  });

  it("updates a saved edited reply alias after an uncertain approval", async () => {
    vi.mocked(approveDecision).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const item = reply();
    const edited = redditReplyItem(item.id, "https://www.reddit.com/r/saas/comments/abc/title/", "Edited reply.");
    const view = renderHook(({ action }) => useRedditPublish(redditPublishKey(action), true), { initialProps: { action: item } });
    await act(async () => {
      await view.result.current.publish(item, "Edited reply.", undefined, async () => { view.rerender({ action: edited }); });
    });
    expect(view.result.current.state).toMatchObject({ status: "unconfirmed", decisionId: "decision-1" });
    expect(view.result.current.state.error).toMatch(/could not confirm/);
  });

  it("clears edited aliases when checking staged drafts fails before approval", async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    const item = reply();
    const edited = redditReplyItem(item.id, "https://www.reddit.com/r/saas/comments/abc/title/", "Edited reply.");
    const view = renderHook(({ action }) => useRedditPublish(redditPublishKey(action), true), { initialProps: { action: item } });
    await act(async () => {
      await view.result.current.publish(item, "Edited reply.", undefined, async () => { view.rerender({ action: edited }); });
    });
    expect(view.result.current.state).toMatchObject({ status: "idle", decisionId: null });
    expect(view.result.current.state.error).toMatch(/could not check/);
    expect(approveDecision).not.toHaveBeenCalled();
  });

  it("serializes different edits of one source across separate module instances", async () => {
    let release: (() => void) | undefined;
    vi.mocked(apiFetch).mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve(response({ drafts: [], drafts_ok: true }));
    }));
    const locks = vi.spyOn(navigator.locks, "request");
    const item = reply();
    const first = publishRedditAction(item, { text: "First edit." }, { ownProposal: false });
    await waitFor(() => expect(release).toBeDefined());
    vi.resetModules();
    const otherDocument = await import("./redditPublishCoordinator");
    const second = otherDocument.publishRedditAction(item, { text: "Second edit." }, { ownProposal: false });
    await waitFor(() => expect(locks.mock.calls).toHaveLength(3));
    expect(apiFetch).toHaveBeenCalledTimes(1);
    release?.();
    await expect(first).resolves.toMatchObject({ status: "published", decisionId: "decision-1" });
    await expect(second).rejects.toThrow(/This edit was not posted/);
    expect(stageCalls()).toHaveLength(1);
    expect(approveDecision).toHaveBeenCalledTimes(1);
  });

  it("checks the submitted-text receipt when distinct originals are edited to the same reply", async () => {
    const a = reply();
    const b = redditReplyItem("other-card", "https://www.reddit.com/r/saas/comments/abc/title/", "A different original.");
    await publishRedditAction(a, { text: "Shared edit." }, { ownProposal: false });
    await publishRedditAction(b, { text: "Shared edit." }, { ownProposal: false });
    expect(stageCalls()).toHaveLength(1);
    expect(approveDecision).toHaveBeenCalledTimes(1);
  });

  it.each(["published", "scheduled", "unconfirmed"])("does not register unsubmitted text when reusing a %s source", async (initial) => {
    if (initial === "scheduled") {
      vi.mocked(approveDecision).mockImplementationOnce(async (id) => {
        data.receipts.set(id, { status: "scheduled", last_error: null });
        return response({ ok: true });
      });
    } else if (initial === "unconfirmed") {
      vi.mocked(approveDecision).mockImplementationOnce(async (id) => {
        data.decisions.get(id)!.status = "approved";
        data.receipts.set(id, { status: "published", last_error: null });
        throw new TypeError("Failed to fetch");
      });
    }
    const source = reply();
    await publishRedditAction(source, { text: "First edit." }, { ownProposal: false }).catch(() => undefined);
    data.receipts.set("decision-1", { status: "published", last_error: null });
    await expect(publishRedditAction(source, { text: "Unsubmitted edit." }, { ownProposal: false })).rejects.toThrow(/This edit was not posted/);
    const other = redditReplyItem("other-card", "https://www.reddit.com/r/saas/comments/abc/title/", "Different original.");
    await publishRedditAction(other, { text: "Unsubmitted edit." }, { ownProposal: false });
    expect(stageCalls()).toHaveLength(2);
    expect(approveDecision).toHaveBeenCalledTimes(2);
  });

  it("does not complete a saved stale edit using another version's receipt", async () => {
    const source = reply();
    await publishRedditAction(source, { text: "First edit." }, { ownProposal: false });
    const stale = redditReplyItem(source.id, "https://www.reddit.com/r/saas/comments/abc/title/", "Saved stale edit.");
    const complete = vi.fn(async () => null);
    const view = renderHook(() => useRedditPublish(redditPublishKey(stale), true));
    await act(async () => { await view.result.current.publish(stale, "Saved stale edit.", complete); });
    expect(complete).not.toHaveBeenCalled();
    expect(view.result.current.state.error).toMatch(/This edit was not posted/);
    const other = redditReplyItem("other-card", "https://www.reddit.com/r/saas/comments/abc/title/", "Saved stale edit.");
    await publishRedditAction(other, { text: "Saved stale edit." }, { ownProposal: false });
    expect(stageCalls()).toHaveLength(2);
  });

  it("changes the submitted alias when an unreceived approval is explicitly edited and approved", async () => {
    vi.mocked(approveDecision).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const source = reply();
    await publishRedditAction(source, { text: "First edit." }, { ownProposal: false }).catch(() => undefined);
    await expect(publishRedditAction(source, { text: "First edit." })).rejects.toBeInstanceOf(RedditApprovalRequired);
    await publishRedditAction(source, { text: "Second edit." });
    const other = redditReplyItem("other-card", "https://www.reddit.com/r/saas/comments/abc/title/", "Different original.");
    await publishRedditAction(other, { text: "First edit." }, { ownProposal: false });
    expect(stageCalls()).toHaveLength(2);
    expect(approveDecision).toHaveBeenCalledTimes(3);
  });

  it("rejects a different edit joined to an in-flight same-source publication", async () => {
    let finish: (() => void) | undefined;
    vi.mocked(approveDecision).mockImplementationOnce((id) => new Promise((resolve) => {
      finish = () => {
        data.receipts.set(id, { status: "published", last_error: null });
        resolve(response({ ok: true }));
      };
    }));
    const source = reply();
    const first = publishRedditAction(source, { text: "First edit." }, { ownProposal: false });
    await waitFor(() => expect(finish).toBeDefined());
    const second = publishRedditAction(source, { text: "Second edit." }, { ownProposal: false });
    const checked = expect(second).rejects.toThrow(/This edit was not posted/);
    finish?.();
    await first;
    await checked;
    expect(stageCalls()).toHaveLength(1);
  });

  it("binds a reused matching receipt to the second source before completion", async () => {
    await publishRedditAction(reply(), { text: "Shared edit." }, { ownProposal: false });
    const second = redditReplyItem("second-card", "https://www.reddit.com/r/saas/comments/abc/title/", "Different original.");
    const completed = vi.fn(async () => null);
    const view = renderHook(() => useRedditPublish(redditPublishKey(second), true));
    await act(async () => { await view.result.current.publish(second, "Shared edit.", completed); });
    expect(completed).toHaveBeenCalledTimes(1);
    expect(view.result.current.state).toMatchObject({ status: "posted", targetKey: expect.stringContaining("Shared edit.") });
    await expect(publishToReddit(second, { text: "Unsubmitted edit." }, false)).rejects.toThrow(/This edit was not posted/);
    expect(stageCalls()).toHaveLength(1);
    expect(approveDecision).toHaveBeenCalledTimes(1);
  });

  it("restores confirmed delivery after a failed completion write and a new document", async () => {
    const item = reply();
    const first = renderHook(() => useRedditPublish(redditPublishKey(item), true));
    await act(async () => {
      await first.result.current.publish(item, "Helpful reply.", async () => "Could not update the card.");
    });
    expect(first.result.current.state).toMatchObject({ status: "posted", error: "Could not update the card." });
    first.unmount();
    resetRedditPublishStates(true);
    const reloaded = renderHook(() => useRedditPublish(redditPublishKey(item), true));
    await waitFor(() => expect(reloaded.result.current.state.status).toBe("posted"));
    await expect(publishToReddit(item, { text: "Helpful reply." }, false)).resolves.toBe(true);
    expect(stageCalls()).toHaveLength(1);
  });

  it("keeps different source posts independent even with identical titles and bodies", async () => {
    const a = redditPostItem("post-a", { subreddit: "saas", title: "Monthly progress", text: "Our update." });
    const b = redditPostItem("post-b", { subreddit: "saas", title: "Monthly progress", text: "Our update." });
    await publishRedditAction(a, { text: "Our update." }, { ownProposal: false });
    await publishRedditAction(b, { text: "Our update." }, { ownProposal: false });
    expect(stageCalls()).toHaveLength(2);
    expect(approveDecision).toHaveBeenCalledTimes(2);
  });

  it("remembers the staged-card alias so another view cannot post its decision again", async () => {
    const source = redditPostItem("source-card", { subreddit: "saas", title: "Update", text: "Our update." });
    const sent = await publishRedditAction(source, { text: "Our update." }, { ownProposal: false });
    resetRedditPublishStates(true);
    await publishToReddit({ ...source, id: sent.decisionId }, { text: "Our update." });
    expect(stageCalls()).toHaveLength(1);
    expect(approveDecision).toHaveBeenCalledTimes(1);
  });

  it("keeps a scheduled submission truthful and checks it without approving again", async () => {
    vi.mocked(approveDecision).mockImplementationOnce(async (id) => {
      data.receipts.set(id, { status: "scheduled", last_error: null });
      return response({ ok: true });
    });
    const item = reply();
    await expect(publishToReddit(item, { text: "Helpful reply." }, false)).rejects.toThrow(/Scheduled on Reddit/);
    data.receipts.set("decision-1", { status: "published", last_error: null });
    await expect(publishToReddit(item, { text: "Helpful reply." }, false)).resolves.toBe(true);
    expect(stageCalls()).toHaveLength(1);
    expect(approveDecision).toHaveBeenCalledTimes(1);
  });

  it("refuses to submit when the durable receipt cannot be saved", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage full"); });
    await expect(publishRedditAction(reply(), { text: "Helpful reply." })).rejects.toThrow(/Enable site storage/);
    expect(stageCalls()).toHaveLength(0);
    expect(approveDecision).not.toHaveBeenCalled();
  });

  it("isolates recovered receipts by active workspace", async () => {
    const item = reply();
    await publishRedditAction(item, { text: "Helpful reply." }, { ownProposal: false });
    resetRedditPublishStates(true);
    data.tenant = "tenant-two";
    await publishRedditAction(item, { text: "Helpful reply." }, { ownProposal: false });
    expect(stageCalls()).toHaveLength(2);
  });
});

it("hydrates with the server snapshot before restoring browser publication state", async () => {
  const item = reply();
  await publishRedditAction(item, { text: "Helpful reply." }, { ownProposal: false });
  resetRedditPublishStates(true);
  function Status() {
    const { state } = useRedditPublish(redditPublishKey(item), true);
    return <span>{state.status}</span>;
  }
  const server = renderToString(<Status />);
  const container = document.createElement("div");
  container.innerHTML = server;
  document.body.appendChild(container);
  const commits: string[] = [];
  const errors = vi.fn();
  let root: ReturnType<typeof hydrateRoot> | undefined;
  await act(async () => {
    root = hydrateRoot(container, <Profiler id="publication" onRender={() => { commits.push(container.innerHTML); }}><Status /></Profiler>, { onRecoverableError: errors });
  });
  expect(commits[0]).toBe(server);
  await waitFor(() => expect(container.textContent).toBe("posted"));
  expect(errors).not.toHaveBeenCalled();
  await act(async () => { root?.unmount(); });
  container.remove();
});
