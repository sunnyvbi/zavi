// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";

const api = vi.hoisted(() => ({ fetch: vi.fn() }));

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
  useAgentRun: () => ({ inflight: false, error: null, send: vi.fn() }),
}));
vi.mock("@/lib/workspace/tenantCommands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/tenantCommands")>()),
  useTenantCommands: () => ({ commands: [], loaded: true, error: null }),
}));
vi.mock("@/lib/workspace/useFeedback", () => ({ submitFeedback: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/api", () => ({
  apiFetch: api.fetch,
  isTransientNetworkError: () => false,
}));

import { Composer, type Attachment } from "./Composer";

Element.prototype.scrollIntoView = () => {};

function Host({ composerKey, onSystem }: { composerKey: string; onSystem: (m: string) => void }) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dropped, setDropped] = useState<{ files: File[]; nonce: number } | null>(null);
  return (
    <div
      data-testid="chat-area"
      onDrop={(e) => {
        const files = Array.from(e.dataTransfer.files);
        if (files.length === 0 || e.defaultPrevented) return;
        e.preventDefault();
        setDropped((cur) => ({ files, nonce: (cur?.nonce ?? 0) + 1 }));
      }}
    >
      <Composer
        key={composerKey}
        agentSlug="operator"
        tabId="t"
        threadId={null}
        onOptimistic={() => "o"}
        onSent={() => {}}
        onSystem={onSystem}
        attachments={attachments}
        onAttachmentsChange={setAttachments}
        droppedFiles={dropped ?? undefined}
      />
    </div>
  );
}

const video = () => new File([new Uint8Array(8)], "clip.mp4", { type: "video/mp4" });
const dataTransfer = (f: File) => ({ files: [f], items: [{ kind: "file" }], types: ["Files"] });

const uploads = () =>
  api.fetch.mock.calls.filter((c) => c[0] === "/api/chat/upload-video").length;

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

afterEach(() => {
  cleanup();
  api.fetch.mockReset();
});

describe("a dropped file is handled once", () => {
  it("a drop on the composer is not delivered again by the chat area around it", async () => {
    api.fetch.mockReturnValue(new Promise(() => {}));
    const onSystem = vi.fn();
    render(<Host composerKey="welcome" onSystem={onSystem} />);
    const composerRoot = screen.getByTestId("chat-area").firstElementChild as HTMLElement;

    fireEvent.drop(composerRoot, { dataTransfer: dataTransfer(video()) });
    await flush();

    expect(uploads()).toBe(1);
    expect(onSystem).not.toHaveBeenCalled();
  });

  it("a remounted composer does not replay the host's last drop", async () => {
    api.fetch.mockReturnValue(new Promise(() => {}));
    const onSystem = vi.fn();
    const { rerender } = render(<Host composerKey="welcome" onSystem={onSystem} />);

    fireEvent.drop(screen.getByTestId("chat-area"), { dataTransfer: dataTransfer(video()) });
    await flush();
    expect(uploads()).toBe(1);

    rerender(<Host composerKey="conversation" onSystem={onSystem} />);
    await flush();

    expect(uploads()).toBe(1);
    expect(onSystem).not.toHaveBeenCalled();
  });

  it("dropping the same file again later still attaches it", async () => {
    api.fetch.mockReturnValue(new Promise(() => {}));
    render(<Host composerKey="conversation" onSystem={() => {}} />);
    const area = screen.getByTestId("chat-area");

    fireEvent.drop(area, { dataTransfer: dataTransfer(video()) });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /remove/i }));
    fireEvent.drop(area, { dataTransfer: dataTransfer(video()) });
    await flush();

    expect(uploads()).toBe(2);
  });
});
