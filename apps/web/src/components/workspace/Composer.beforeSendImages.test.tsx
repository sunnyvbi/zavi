// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const run = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("./WorkspaceShell", () => {
  const noop = () => {};
  return {
    useWorkspace: () => ({
      setTabDirty: noop,
      setTabThreadId: noop,
      role: "owner",
      composerSeeds: {},
      consumeComposerSeed: noop,
      closeTab: noop,
      openTab: noop,
    }),
  };
});
vi.mock("@/lib/workspace/useAgentRun", () => ({
  useAgentRun: () => ({ inflight: false, error: null, send: run.send }),
}));
vi.mock("@/lib/workspace/tenantCommands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/tenantCommands")>()),
  useTenantCommands: () => ({ commands: [], loaded: true, error: null }),
}));
vi.mock("@/lib/workspace/useFeedback", () => ({ submitFeedback: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/api", () => ({ apiFetch: vi.fn(async () => ({ ok: true, json: async () => ({}) })) }));

import { Composer, type Attachment } from "./Composer";

Element.prototype.scrollIntoView = () => {};

const shot: Attachment = { id: "a1", kind: "image", name: "shot.png", status: "ready", previewUrl: "blob:x", mime: "image/png", path: "tenant-1/chat/shot.png" };
const doc: Attachment = { id: "a2", kind: "doc", name: "brief.pdf", status: "ready", previewUrl: "", mime: "application/pdf", path: "tenant-1/chat/brief.pdf" };
const queued = { kind: "queued", thread_id: "th", user_message_id: "m", run_id: "r" };

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

type Intercept = { handled: boolean; creditWall?: string; system?: string; consumed?: boolean };

function sendWith(
  attachments: Attachment[],
  takesImages: boolean,
  onBeforeSend: (m: string, images?: string[]) => Promise<Intercept>,
  onAttachmentsChange: (next: unknown) => void = () => {},
) {
  render(
    <Composer
      agentSlug="operator"
      tabId="t"
      threadId={null}
      onOptimistic={() => "o"}
      onSent={() => {}}
      onBeforeSend={onBeforeSend}
      beforeSendTakesImages={takesImages}
      attachments={attachments}
      onAttachmentsChange={onAttachmentsChange}
    />,
  );
  const box = screen.getByRole("textbox") as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: "Make this button bigger" } });
  fireEvent.keyDown(box, { key: "Enter" });
}

afterEach(() => {
  cleanup();
  run.send.mockReset();
});

describe("a screenshot turn reaches a host that takes images", () => {
  it("hands the host the message and the screenshot path, and sends no agent run when it is handled", async () => {
    const onBeforeSend = vi.fn(async () => ({ handled: true }));
    sendWith([shot], true, onBeforeSend);
    await flush();
    expect(onBeforeSend).toHaveBeenCalledWith("Make this button bigger", ["tenant-1/chat/shot.png"]);
    expect(run.send).not.toHaveBeenCalled();
  });

  it("a host that did not opt in never sees an image turn: it goes to the agent with the image", async () => {
    run.send.mockResolvedValue(queued);
    const onBeforeSend = vi.fn(async () => ({ handled: true }));
    sendWith([shot], false, onBeforeSend);
    await flush();
    expect(onBeforeSend).not.toHaveBeenCalled();
    expect(run.send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(run.send.mock.calls[0])).toContain("tenant-1/chat/shot.png");
  });

  it("a screenshot sent with a document skips the host and keeps both on the agent turn", async () => {
    run.send.mockResolvedValue(queued);
    const onBeforeSend = vi.fn(async () => ({ handled: true }));
    sendWith([shot, doc], true, onBeforeSend);
    await flush();
    expect(onBeforeSend).not.toHaveBeenCalled();
    expect(run.send).toHaveBeenCalledTimes(1);
  });

  it("a refused screenshot change (no credits) puts the message and the screenshot back in the box", async () => {
    const changes: unknown[] = [];
    sendWith([shot], true, vi.fn(async () => ({ handled: true, creditWall: "You are out of credits." })), (n) => changes.push(n));
    await flush();
    expect(changes.at(-1)).toEqual([shot]);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Make this button bigger");
    expect(run.send).not.toHaveBeenCalled();
  });

  it("a refused screenshot change with a plain error also keeps the screenshot", async () => {
    const changes: unknown[] = [];
    sendWith([shot], true, vi.fn(async () => ({ handled: true, system: "attach at most 3 images to a change" })), (n) => changes.push(n));
    await flush();
    expect(changes.at(-1)).toEqual([shot]);
  });

  it("an accepted screenshot change leaves the box empty", async () => {
    const changes: unknown[] = [];
    sendWith([shot], true, vi.fn(async () => ({ handled: true, consumed: true, system: "On it." })), (n) => changes.push(n));
    await flush();
    expect(changes.some((c) => Array.isArray(c) && c.length > 0)).toBe(false);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  });
});
