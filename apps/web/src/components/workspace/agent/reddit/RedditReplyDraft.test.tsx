// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RedditReplyDraft } from "./RedditReplyDraft";
import { send } from "./shared";
import { submitToReddit, type RedditDelivery } from "./publish";
import { draftDetail } from "./draftDetail";
import { ExtraTable } from "../../actions/ExtraTable";
import { ChannelSurface } from "../../actions/ChannelSurface";
import { approveDecision } from "@/lib/approvals/approveDecision";
import { startRailConnect } from "@/app/connectors/connectStrategies";

vi.mock("./shared", () => ({ send: vi.fn() }));
vi.mock("./publish", async (importOriginal) => ({ ...(await importOriginal<typeof import("./publish")>()), submitToReddit: vi.fn() }));
import { resetRedditPublishStates } from "./useRedditPublish";
vi.mock("@/lib/active-tenant-client", () => ({ getActiveTenantId: async () => "tenant-test" }));
const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/lib/approvals/approveDecision", () => ({ approveDecision: vi.fn() }));
vi.mock("@/app/connectors/connectStrategies", () => ({ startRailConnect: vi.fn() }));
const props = {
  threadId: "33333333-3333-4333-8333-333333333333",
  url: "https://www.reddit.com/r/test/comments/abc123/example/",
  text: "Original reply.", posted: false, connected: true, onChanged: vi.fn(),
};
const saveMock = vi.mocked(send);
const publishMock = vi.mocked(submitToReddit);
const edit = () => fireEvent.click(screen.getByRole("button", { name: "Edit" }));
const saveEdit = () => fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }));

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  resetRedditPublishStates();
  vi.clearAllMocks();
  saveMock.mockResolvedValue(null);
  publishMock.mockResolvedValue({ decisionId: "d-reply", status: "published" });
  apiFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
  vi.mocked(startRailConnect).mockResolvedValue(undefined as never);
});
const approveMock = vi.mocked(approveDecision);
const approvePosts = () => apiFetch.mock.calls.filter(([path]) => /\/approve(\?|$)/.test(String(path)));
const markDone = async () => {
  fireEvent.click(screen.getByRole("button", { name: "More actions" }));
  await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: /^Done/ })));
};
afterEach(cleanup);

it("opens the same editable post card from a table draft", async () => {
  render(<ExtraTable data={{ title: "Mentions", columns: [{ label: "Thread" }], empty: "None", rows: [{ id: props.threadId, cells: [{ text: "A thread" }], detail: draftDetail(props.threadId, props.url, { text: props.text, state: "drafted" }, undefined, true) }] }} />);
  fireEvent.click(screen.getByRole("button", { name: "Show draft" }));
  expect((await screen.findByTestId("post-text")).textContent).toBe(props.text);
  edit();
  expect((screen.getByRole("textbox", { name: "Edit post" }) as HTMLTextAreaElement).value).toBe(props.text);
});

it("saves edited text as a draft, survives reopening, and publishes that text", async () => {
  const view = render(<RedditReplyDraft {...props} />);
  edit();
  fireEvent.change(screen.getByRole("textbox", { name: "Edit post" }), { target: { value: "Edited reply." } });
  saveEdit();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(saveMock).toHaveBeenCalledWith(`/api/reddit/threads/${props.threadId}`, "PATCH", { draft_state: "drafted", draft_text: "Edited reply." });
  expect(publishMock).not.toHaveBeenCalled();
  view.unmount();
  render(<RedditReplyDraft {...props} text="Edited reply." />);
  expect(screen.getByTestId("post-text").textContent).toBe("Edited reply.");
  fireEvent.click(screen.getByRole("button", { name: "Post on Reddit" }));
  await waitFor(() => expect(publishMock).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({ link: props.url }) }), { text: "Edited reply." }, expect.objectContaining({ ownProposal: false, publishNow: true })));
  expect(await screen.findByText(/Posted to Reddit/)).toBeTruthy();
  expect(saveMock).toHaveBeenLastCalledWith(`/api/reddit/threads/${props.threadId}`, "PATCH", { draft_state: "posted", draft_text: "Edited reply." });
});

it("keeps edits visible and offers a retry when saving fails", async () => {
  saveMock.mockResolvedValueOnce("Could not save.");
  render(<RedditReplyDraft {...props} />);
  edit();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Keep these edits." } });
  saveEdit();
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Could not save.");
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Keep these edits.");
  saveEdit();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByTestId("post-text").textContent).toBe("Keep these edits.");
});

it("does not publish if the save fails", async () => {
  saveMock.mockResolvedValue("Save failed.");
  render(<RedditReplyDraft {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Post on Reddit" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Save failed.");
  expect(publishMock).not.toHaveBeenCalled();
});

it("surfaces publishing failures without hiding the draft", async () => {
  publishMock.mockRejectedValue(new Error("Reconnect Reddit."));
  render(<RedditReplyDraft {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Post on Reddit" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Reconnect Reddit.");
  expect(screen.getByRole("button", { name: "Post on Reddit" }).hasAttribute("disabled")).toBe(false);
});

it("offers Connect Reddit to post when disconnected, and the press starts the connect flow without posting or saving", async () => {
  render(<RedditReplyDraft {...props} connected={false} />);
  const connect = screen.getByRole("button", { name: "Connect Reddit to post" });
  expect(connect.hasAttribute("disabled")).toBe(false);
  expect(screen.queryByRole("button", { name: "Post on Reddit" })).toBeNull();
  await act(async () => fireEvent.click(connect));
  expect(startRailConnect).toHaveBeenCalledWith("reddit", "reddit_social");
  expect(publishMock).not.toHaveBeenCalled();
  expect(saveMock).not.toHaveBeenCalled();
  expect(approveMock).not.toHaveBeenCalled();
  expect(screen.queryByText("Marked as posted.")).toBeNull();
});

it("says so when the connect flow cannot start", async () => {
  vi.mocked(startRailConnect).mockRejectedValueOnce(new Error("popup blocked"));
  render(<RedditReplyDraft {...props} connected={false} />);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Connect Reddit to post" })));
  expect((await screen.findByRole("alert")).textContent).toBe("Couldn't start connecting Reddit. Try again from Settings.");
  expect(publishMock).not.toHaveBeenCalled();
});

it("keeps Copy and Done for a founder who posts it by hand", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  render(<RedditReplyDraft {...props} connected={false} />);
  fireEvent.click(screen.getByRole("button", { name: "More actions" }));
  expect(screen.getByRole("menuitem", { name: /^Done/ })).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: /^Copy/ })));
  expect(writeText).toHaveBeenCalledWith(props.text);
});

describe("Done, for a reply the founder posted themselves", () => {
  const RUN_DECISION = "44444444-4444-4444-8444-444444444444";
  const threadPatch = (state: string) => [`/api/reddit/threads/${props.threadId}`, "PATCH", { draft_state: state }];

  it("marks the thread posted and never approves anything", async () => {
    render(<RedditReplyDraft {...props} />);
    await markDone();
    expect(await screen.findByText("Marked as posted.")).toBeTruthy();
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(saveMock).toHaveBeenCalledWith(...threadPatch("posted"));
    expect(publishMock).not.toHaveBeenCalled();
    expect(approveMock).not.toHaveBeenCalled();
    expect(approvePosts()).toHaveLength(0);
    expect(apiFetch).not.toHaveBeenCalled();
    expect(props.onChanged).toHaveBeenCalledTimes(1);
  });

  it("archives the run decision behind the draft, and never approves it", async () => {
    render(<RedditReplyDraft {...props} suggestionId={RUN_DECISION} suggestionSource="decision" />);
    await markDone();
    expect(await screen.findByText("Marked as posted.")).toBeTruthy();
    expect(saveMock).toHaveBeenCalledWith(...threadPatch("posted"));
    expect(apiFetch.mock.calls.map(([path, init]) => [path, (init as RequestInit).method])).toEqual([[`/api/approvals/${RUN_DECISION}/archive`, "POST"]]);
    expect(approveMock).not.toHaveBeenCalled();
    expect(approvePosts()).toHaveLength(0);
    expect(publishMock).not.toHaveBeenCalled();
  });

  it("archives when the run decision's source is unknown, too", async () => {
    render(<RedditReplyDraft {...props} suggestionId={RUN_DECISION} />);
    await markDone();
    await screen.findByText("Marked as posted.");
    expect(apiFetch.mock.calls.map(([path]) => path)).toEqual([`/api/approvals/${RUN_DECISION}/archive`]);
    expect(approveMock).not.toHaveBeenCalled();
  });

  it("sets a channel action to acted, and nothing else", async () => {
    render(<RedditReplyDraft {...props} suggestionId={RUN_DECISION} suggestionSource="channel_action" />);
    await markDone();
    await screen.findByText("Marked as posted.");
    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [path, init] = apiFetch.mock.calls[0];
    expect(path).toBe(`/api/channel-actions/${RUN_DECISION}`);
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({ action: "acted" });
    expect(approveMock).not.toHaveBeenCalled();
    expect(approvePosts()).toHaveLength(0);
  });

  it("says the card could not be closed when the archive is refused, but keeps the posted mark", async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    render(<RedditReplyDraft {...props} suggestionId={RUN_DECISION} suggestionSource="decision" />);
    await markDone();
    expect((await screen.findByRole("alert")).textContent).toBe("Marked as posted, but Zavi could not close this card. Refresh to check it.");
    expect(screen.getByText("Marked as posted.")).toBeTruthy();
    expect(approveMock).not.toHaveBeenCalled();
  });

  it("does not close the card when the thread could not be marked", async () => {
    saveMock.mockResolvedValue("Couldn't save that. Try again in a moment.");
    render(<RedditReplyDraft {...props} suggestionId={RUN_DECISION} suggestionSource="decision" />);
    await markDone();
    expect((await screen.findByRole("alert")).textContent).toBe("Couldn't save that. Try again in a moment.");
    expect(screen.queryByText("Marked as posted.")).toBeNull();
    expect(apiFetch).not.toHaveBeenCalled();
    expect(props.onChanged).not.toHaveBeenCalled();
  });

  it("routes a run draft's decision from the table through draftDetail", async () => {
    render(<ExtraTable data={{ title: "Mentions", columns: [{ label: "Thread" }], empty: "None", rows: [{ id: props.threadId, cells: [{ text: "A thread" }], detail: draftDetail(props.threadId, props.url, { text: props.text, state: "drafted", source: "run", decision_id: RUN_DECISION, action_source: "decision" }, undefined, true) }] }} />);
    fireEvent.click(screen.getByRole("button", { name: "Show draft" }));
    await screen.findByTestId("post-text");
    await markDone();
    await screen.findByText("Marked as posted.");
    expect(apiFetch.mock.calls.map(([path]) => path)).toEqual([`/api/approvals/${RUN_DECISION}/archive`]);
    expect(approveMock).not.toHaveBeenCalled();
  });

  it("closes no card for a scan draft that has no decision behind it", async () => {
    render(<ExtraTable data={{ title: "Mentions", columns: [{ label: "Thread" }], empty: "None", rows: [{ id: props.threadId, cells: [{ text: "A thread" }], detail: draftDetail(props.threadId, props.url, { text: props.text, state: "drafted", source: "zavi", decision_id: RUN_DECISION }, undefined, true) }] }} />);
    fireEvent.click(screen.getByRole("button", { name: "Show draft" }));
    await screen.findByTestId("post-text");
    await markDone();
    await screen.findByText("Marked as posted.");
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

describe("the edit dialog on a channel page", () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
    HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  });
  const openDialog = () => {
    render(<ChannelSurface slug="reddit_organic"><RedditReplyDraft {...props} /></ChannelSurface>);
    edit();
    return screen.getByRole("dialog", { name: "Edit the reply" });
  };

  it("saves through the thread draft, never the channel-action post-draft store", async () => {
    const dialog = openDialog();
    expect(apiFetch.mock.calls.some(([path]) => String(path).includes("post-draft"))).toBe(false);
    fireEvent.change(screen.getByLabelText("Edit post"), { target: { value: "Dialog edit." } });
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Save" })));
    expect(saveMock).toHaveBeenCalledWith(`/api/reddit/threads/${props.threadId}`, "PATCH", { draft_state: "drafted", draft_text: "Dialog edit." });
    expect(apiFetch.mock.calls.some(([path]) => String(path).includes("post-draft"))).toBe(false);
  });

  it("disables Save and says why for a blank reply", () => {
    const dialog = openDialog();
    fireEvent.change(screen.getByLabelText("Edit post"), { target: { value: "   " } });
    expect(within(dialog).getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
    expect(within(dialog).getByText("Write something before posting.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(saveMock).not.toHaveBeenCalled();
  });

  it("disables Save and says why for a reply over the limit", () => {
    const dialog = openDialog();
    fireEvent.change(screen.getByLabelText("Edit post"), { target: { value: "a".repeat(4001) } });
    expect(within(dialog).getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
    expect(within(dialog).getByText(/over Reddit's 4000-character limit/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Edit post"), { target: { value: "a".repeat(4000) } });
    expect(within(dialog).getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(false);
  });
});

it("removes Copy, Open draft and Mark as posted while keeping Edit", () => {
  render(<RedditReplyDraft {...props} />);
  expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "More actions" }));
  expect(screen.queryByRole("menuitem", { name: /^Not now/ })).toBeNull();
  expect(screen.queryByRole("menuitem", { name: /Copy|Open draft|Mark as posted/ })).toBeNull();
});

it("disables Post while delivery is pending", async () => {
  let deliver: (value: RedditDelivery) => void = () => undefined;
  publishMock.mockImplementation(() => new Promise((resolve) => { deliver = resolve; }));
  render(<RedditReplyDraft {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Post on Reddit" }));
  await waitFor(() => expect(publishMock).toHaveBeenCalledTimes(1));
  expect(screen.getByRole("button", { name: "Post on Reddit" }).hasAttribute("disabled")).toBe(true);
  expect(saveMock.mock.calls.some((call) => (call[2] as { draft_state: string }).draft_state === "posted")).toBe(false);
  await act(async () => deliver({ decisionId: "d-reply", status: "published" }));
  expect(await screen.findByText("Posted to Reddit.")).toBeTruthy();
});
