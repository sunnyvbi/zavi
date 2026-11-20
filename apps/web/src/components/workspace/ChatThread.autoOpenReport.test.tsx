// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";

vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async () => ({ ok: true, json: async () => ({ signed_url: "https://signed/x" }) })),
}));
vi.mock("./WorkspaceShell", () => ({ useWorkspace: () => ({ seedComposer: vi.fn(), openAgentTab: vi.fn() }) }));
vi.mock("@/lib/workspace/useAgentRun", () => ({ useAgentRun: () => ({ send: vi.fn(), inflight: false }) }));
vi.mock("./ChatBubble", () => ({ ChatBubble: ({ text }: { text: string }) => <div>{text}</div> }));
vi.mock("./PostPreview", () => ({ PostPreview: () => null }));
vi.mock("recharts", async () => {
  const actual = await vi.importActual<typeof import("recharts")>("recharts");
  return { ...actual, ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div> };
});

import { RowRenderer, type ChatRow } from "./ChatThread";
import { ArtifactPreviewProvider, useArtifactPreview } from "./artifacts/artifactPreviewContext";

const table = { kind: "table", title: "Sign-ups by month", columns: ["Month", "Sign-ups"], rows: [["July", "1,587"], ["August", "2,497"]] };

function Probe() {
  const { open } = useArtifactPreview();
  return <div data-testid="probe">{open ? `open:${open.artifact.id}:${open.report ? "report" : "plain"}` : "closed"}</div>;
}

function row(id: string): ChatRow {
  return {
    id: "r1",
    kind: "chat_assistant",
    created_at: "2026-09-25T13:09:09Z",
    body: { text: "Here are the numbers." },
    artifacts: [{ id, filename: "ui-block-100.json", mime: "application/vnd.zavi.ui+json", bytes: 100 }],
  } as unknown as ChatRow;
}

const mediaListeners = new Set<() => void>();
let currentWidth = 1600;
function setWidth(px: number) {
  currentWidth = px;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: px });
  vi.stubGlobal("matchMedia", (q: string) => {
    const min = Number(q.match(/(\d+)px/)?.[1] ?? 0);
    return {
      get matches() {
        return currentWidth >= min;
      },
      addEventListener: (_: string, fn: () => void) => mediaListeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => mediaListeners.delete(fn),
    };
  });
}
function resizeTo(px: number) {
  currentWidth = px;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: px });
  act(() => mediaListeners.forEach((fn) => fn()));
}

beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => table })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("latest data answer opens its report", () => {
  it("opens on a wide window", async () => {
    setWidth(1600);
    const { getByTestId } = render(
      <ArtifactPreviewProvider>
        <RowRenderer row={row("a-wide")} agentSlug="operator" isLast />
        <Probe />
      </ArtifactPreviewProvider>,
    );
    await waitFor(() => expect(getByTestId("probe").textContent).toBe("open:a-wide:report"));
  });

  it("opens wherever the button works, not only past a second cutoff", async () => {
    setWidth(1100);
    const { getByTestId } = render(
      <ArtifactPreviewProvider>
        <RowRenderer row={row("a-mid")} agentSlug="operator" isLast />
        <Probe />
      </ArtifactPreviewProvider>,
    );
    await waitFor(() => expect(getByTestId("probe").textContent).toBe("open:a-mid:report"));
  });

  it("does not open where the pane cannot dock", async () => {
    setWidth(900);
    const { getByTestId, findByText } = render(
      <ArtifactPreviewProvider>
        <RowRenderer row={row("a-narrow")} agentSlug="operator" isLast />
        <Probe />
      </ArtifactPreviewProvider>,
    );
    await findByText("Sign-ups by month");
    expect(getByTestId("probe").textContent).toBe("closed");
  });

  it("never replaces a pane the person already opened", async () => {
    setWidth(1600);
    function OpenFirst() {
      const { openArtifact } = useArtifactPreview();
      return (
        <button
          onClick={() =>
            openArtifact({
              artifact: { id: "pdf-1", run_id: "", title: "doc", filename: "doc.pdf", mime: "application/pdf", type: "document", bytes: 1, created_at: "", updated_at: "", preview_url: null, source: { kind: "chat", id: "", title: "", href: "" } },
              onDownload: () => {},
            })
          }
        >
          open pdf
        </button>
      );
    }
    const { getByTestId, getByText, findByText } = render(
      <ArtifactPreviewProvider>
        <OpenFirst />
        <Probe />
      </ArtifactPreviewProvider>,
    );
    getByText("open pdf").click();
    await waitFor(() => expect(getByTestId("probe").textContent).toBe("open:pdf-1:plain"));
    cleanup();
    const second = render(
      <ArtifactPreviewProvider>
        <OpenFirst />
        <RowRenderer row={row("a-late")} agentSlug="operator" isLast />
        <Probe />
      </ArtifactPreviewProvider>,
    );
    second.getByText("open pdf").click();
    await second.findByText("Sign-ups by month");
    await new Promise((r) => setTimeout(r, 30));
    expect(second.getByTestId("probe").textContent).toBe("open:pdf-1:plain");
    void findByText;
  });

  it("does not come back when a pane that replaced it is closed", async () => {
    setWidth(1600);
    function Controls() {
      const { openArtifact, close } = useArtifactPreview();
      return (
        <>
          <button onClick={() => openArtifact({ artifact: { id: "pdf-2", run_id: "", title: "doc", filename: "doc.pdf", mime: "application/pdf", type: "document", bytes: 1, created_at: "", updated_at: "", preview_url: null, source: { kind: "chat", id: "", title: "", href: "" } }, onDownload: () => {} })}>open pdf</button>
          <button onClick={close}>close pane</button>
        </>
      );
    }
    const r = render(
      <ArtifactPreviewProvider>
        <Controls />
        <RowRenderer row={row("a-back")} agentSlug="operator" isLast />
        <Probe />
      </ArtifactPreviewProvider>,
    );
    await waitFor(() => expect(r.getByTestId("probe").textContent).toBe("open:a-back:report"));
    r.getByText("open pdf").click();
    await waitFor(() => expect(r.getByTestId("probe").textContent).toBe("open:pdf-2:plain"));
    r.getByText("close pane").click();
    await new Promise((res) => setTimeout(res, 30));
    expect(r.getByTestId("probe").textContent).toBe("closed");
  });

  it("comes back after the window narrows and widens again", async () => {
    setWidth(1600);
    const r = render(
      <ArtifactPreviewProvider>
        <RowRenderer row={row("a-resize")} agentSlug="operator" isLast />
        <Probe />
      </ArtifactPreviewProvider>,
    );
    await waitFor(() => expect(r.getByTestId("probe").textContent).toBe("open:a-resize:report"));
    resizeTo(900);
    await waitFor(() => expect(r.getByTestId("probe").textContent).toBe("closed"));
    resizeTo(1600);
    await waitFor(() => expect(r.getByTestId("probe").textContent).toBe("open:a-resize:report"));
  });

  it("does not open for an earlier reply", async () => {
    setWidth(1600);
    const { getByTestId, findByText } = render(
      <ArtifactPreviewProvider>
        <RowRenderer row={row("a-old")} agentSlug="operator" isLast={false} />
        <Probe />
      </ArtifactPreviewProvider>,
    );
    await findByText("Sign-ups by month");
    expect(getByTestId("probe").textContent).toBe("closed");
  });
});
