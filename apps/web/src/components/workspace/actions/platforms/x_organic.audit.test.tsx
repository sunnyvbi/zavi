// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChannelActionCard } from "../ChannelActionCard";
import { makeAction } from "../__tests__/fixtures";
import { x_organic } from "./x_organic";
import { postContent } from "../types";

const mocks = vi.hoisted(() => ({ publish: vi.fn(async () => "decision-1"), follow: vi.fn(async () => ({ state: "failed" })), fetch: vi.fn() }));
vi.mock("../../agent/xStagedPosts", async (orig) => ({ ...(await orig<typeof import("../../agent/xStagedPosts")>()), publishPost: mocks.publish }));
vi.mock("../topActions/postToast", () => ({ followPostInToast: mocks.follow }));
vi.mock("@/lib/api", () => ({ apiFetch: mocks.fetch }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const makeParts = () => [{ label: "Post 1", content: "Start here." }, { label: "Post 2", content: "Then do this." }, { label: "Post 3", content: "Finish here." }];
const thread = () => { const parts = makeParts(); return makeAction("text_post", { body: { step: { deliverable: { kind: "thread", content: parts.map(p => p.content).join("\n\n"), parts } } } }); };
const handlers = () => ({ onSetStatus: vi.fn(), onRedo: vi.fn(), onPublish: vi.fn(async (..._args: unknown[]) => true) });

it("publishes every ordered thread part without its presentation labels", async () => {
  const h = handlers();
  render(<ChannelActionCard action={thread()} platform={x_organic} handlers={h} />);
  expect(screen.queryAllByRole("tab")).toHaveLength(0);
  expect(screen.getByRole("article").textContent).toContain("Finish here.");
  fireEvent.click(screen.getByRole("button", { name: "Post on X" }));
  await waitFor(() => expect(h.onPublish).toHaveBeenCalledTimes(1));
  expect(h.onPublish.mock.calls[0][1]).toEqual({ text: "Start here.", thread: ["Then do this.", "Finish here."] });
  expect(postContent(thread())).toEqual({ text: "Start here.", thread: ["Then do this.", "Finish here."] });
});

it("blocks an over-limit weighted thread part before publishing", () => {
  const a = thread();
  a.body.step!.deliverable!.parts![2].content = "界".repeat(141);
  render(<ChannelActionCard action={a} platform={x_organic} handlers={handlers()} />);
  expect(screen.getByRole("button", { name: "Post on X" })).toHaveProperty("disabled", true);
});

it("follows the approved X decision through the existing outcome watcher", async () => {
  const a = makeAction("text_post", { id: "decision-1", run_id: null, body: { step: { deliverable: { kind: "post", content: "Draft" } } } });
  await x_organic.publish!(a, { text: "Draft", thread: null }, { tenantId: "workspace-1" });
  expect(mocks.follow).toHaveBeenCalledWith("decision-1", "X", undefined, "workspace-1");
});

it("uses only a connected provider-confirmed handle as publishing identity", () => {
  expect(x_organic.accountFromPayload?.({ connected: true, account_name: "Company", account_handle: "company" })).toEqual({ name: "Company", handle: "@company" });
  expect(x_organic.accountFromPayload?.({ connected: false, account_name: "Old company", account_handle: "old" })).toBeUndefined();
  expect(x_organic.accountFromPayload?.({ connected: true, account_name: "Old company", handle: "editable-label" })).toBeUndefined();
});

it.each([[""], ["Two", "Three", "Four", "Five", "Six"]])("keeps an invalid thread editable without enabling Post: %j", (...tail) => {
  const a = makeAction("text_post", { body: { step: { deliverable: { kind: "thread", content: "First" } }, thread: tail } });
  render(<ChannelActionCard action={a} platform={x_organic} handlers={handlers()} />);
  expect(screen.getByRole("button", { name: "Post on X" })).toHaveProperty("disabled", true);
});
