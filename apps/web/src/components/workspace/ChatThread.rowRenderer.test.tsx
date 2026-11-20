// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RowRenderer, shouldAutoOpenReport } from "./ChatThread";
import { ArtifactPreviewProvider } from "./artifacts/artifactPreviewContext";
import type { ChatRow } from "./ChatThread";

vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async () => ({
    ok: true,
    json: async () => ({ signed_url: "https://storage.example/signed/media" }),
  })),
}));

const workspace = vi.hoisted(() => ({ role: "owner" as string | null }));

vi.mock("./WorkspaceShell", () => ({
  useWorkspace: () => ({ seedComposer: vi.fn(), openAgentTab: vi.fn(), role: workspace.role }),
}));

vi.mock("@/lib/workspace/useAgentRun", () => ({
  useAgentRun: () => ({ send: vi.fn(), inflight: false }),
}));

vi.mock("./ChatBubble", () => ({
  ChatBubble: ({
    role,
    text,
    variant,
    onEdit,
    feedbackRunId,
  }: {
    role: string;
    text: string;
    variant?: string;
    onEdit?: () => void;
    feedbackRunId?: string;
  }) => (
    <div data-testid={`bubble-${role}`} data-variant={variant ?? "unset"} data-feedback-run={feedbackRunId ?? "none"}>
      {text}
      {onEdit && <button onClick={onEdit}>Edit</button>}
    </div>
  ),
}));

vi.mock("@/components/agents/ApprovalBlock", () => ({
  ApprovalBlock: () => <div data-testid="approval-block" />,
}));

vi.mock("./SummonedSurface", () => ({
  SummonedSurface: ({ surface }: { surface: { key: string } }) => (
    <div data-testid="summoned-surface" data-key={surface.key} />
  ),
}));

vi.mock("./UiBlockArtifact", () => ({
  UiBlockArtifact: ({ onOpenAnalysis }: { onOpenAnalysis?: unknown }) => (
    <div data-testid="ui-block" data-can-open={onOpenAnalysis ? "yes" : "no"} />
  ),
  UiBlockSkeleton: () => null,
}));

vi.mock("./LiveAppPreview", () => ({
  LiveAppPreview: () => <div data-testid="live-app-preview" />,
}));

function row(partial: Partial<ChatRow> & { kind: string }): ChatRow {
  return {
    id: "row-1",
    created_at: "2026-07-18T00:00:00.000Z",
    body: {},
    ...partial,
  } as unknown as ChatRow;
}

afterEach(() => {
  cleanup();
  workspace.role = "owner";
});

describe("RowRenderer (exported seam)", () => {
  it("renders a user row standalone — no ChatThread wrapper", () => {
    render(
      <RowRenderer
        row={row({ kind: "chat_user", body: { text: "hello there" } })}
        agentSlug="research"
      />,
    );
    expect(screen.getByTestId("bubble-user").textContent).toBe("hello there");
  });

  it("renders a system row", () => {
    render(
      <RowRenderer
        row={row({ kind: "chat_system", body: { text: "run cancelled" } })}
        agentSlug="research"
      />,
    );
    expect(screen.getByTestId("bubble-system").textContent).toBe(
      "run cancelled",
    );
  });

  it("renders an assistant row", () => {
    render(
      <RowRenderer
        row={row({ kind: "chat_assistant", body: { text: "the answer" } })}
        agentSlug="research"
      />,
    );
    expect(screen.getByTestId("bubble-assistant").textContent).toBe(
      "the answer",
    );
  });

  it("renders a decision row as an ApprovalBlock", () => {
    render(
      <RowRenderer row={row({ kind: "decision" })} agentSlug="research" />,
    );
    expect(screen.getByTestId("approval-block")).toBeTruthy();
  });

  it("renders nothing for a non-bubble row kind (chat_activity)", () => {
    const { container } = render(
      <RowRenderer row={row({ kind: "chat_activity" })} agentSlug="research" />,
    );
    expect(container.innerHTML).toBe("");
  });
});

describe("RowRenderer — variant forwarding", () => {
  afterEach(() => cleanup());

  it("forwards variant to the USER bubble", () => {
    render(
      <RowRenderer
        row={row({ kind: "chat_user", body: { text: "hi" } })}
        agentSlug="pm"
        variant="flat"
      />,
    );
    expect(screen.getByTestId("bubble-user").dataset.variant).toBe("flat");
  });

  it("forwards variant to the ASSISTANT bubble", () => {
    render(
      <RowRenderer
        row={row({ kind: "chat_assistant", body: { text: "yo" } })}
        agentSlug="pm"
        variant="flat"
      />,
    );
    expect(screen.getByTestId("bubble-assistant").dataset.variant).toBe("flat");
  });

  it("defaults to the bubble shape when no variant is given", () => {
    render(
      <RowRenderer
        row={row({ kind: "chat_assistant", body: { text: "yo" } })}
        agentSlug="pm"
      />,
    );
    expect(screen.getByTestId("bubble-assistant").dataset.variant).toBe("bubble");
  });
});

describe("RowRenderer — summoned surface (front door option C)", () => {
  afterEach(() => cleanup());

  it("mounts the surface under an assistant reply that carries one", () => {
    render(
      <RowRenderer
        row={row({
          kind: "chat_assistant",
          body: { text: "Two PRs are waiting on you." },
          summonedSurface: {
            key: "builds",
            dashboardSlug: "engineer",
            label: "Your builds",
          },
        })}
        agentSlug="operator"
      />,
    );
    expect(screen.getByTestId("summoned-surface").dataset.key).toBe("builds");
  });

  it("mounts nothing on a reply that summons nothing — the common case", () => {
    render(
      <RowRenderer
        row={row({ kind: "chat_assistant", body: { text: "Your MRR is flat." } })}
        agentSlug="operator"
      />,
    );
    expect(screen.queryByTestId("summoned-surface")).toBeNull();
  });

  it("never mounts a surface on a USER turn", () => {
    render(
      <RowRenderer
        row={row({
          kind: "chat_user",
          body: { text: "any open PRs?" },
          summonedSurface: {
            key: "builds",
            dashboardSlug: "engineer",
            label: "Your builds",
          },
        })}
        agentSlug="operator"
      />,
    );
    expect(screen.queryByTestId("summoned-surface")).toBeNull();
  });
});

vi.mock("./chat/ScheduleChip", () => ({
  ScheduleChip: ({ slug }: { slug: string }) => <div data-testid="schedule-chip">{slug}</div>,
}));

describe("RowRenderer — standing-order brief", () => {
  afterEach(cleanup);

  it("mounts the schedule chip for the specialist slug", () => {
    render(
      <RowRenderer
        row={row({
          kind: "chat_assistant",
          body: { text: "🕒 Scheduled brief" },
          standingOrder: true,
          fromAgentSlug: "x_organic",
        })}
        agentSlug="operator"
      />,
    );
    expect(screen.getByTestId("schedule-chip").textContent).toBe("x_organic");
  });

  it("no chip on an ordinary assistant row", () => {
    render(
      <RowRenderer
        row={row({ kind: "chat_assistant", body: { text: "hi" } })}
        agentSlug="operator"
      />,
    );
    expect(screen.queryByTestId("schedule-chip")).toBeNull();
  });
});

describe("RowRenderer — chat media opens the in-app preview", () => {
  afterEach(cleanup);

  const mediaRow = (mime: string, filename: string) =>
    row({
      kind: "chat_assistant",
      body: { text: "Here it is." },
      artifacts: [{ id: "art-1", filename, mime, bytes: 1024 }],
    });

  it("opens an image in the preview instead of a new tab", async () => {
    render(<RowRenderer row={mediaRow("image/png", "post.png")} agentSlug="operator" />);
    const open = await screen.findByRole("button", { name: "Open post.png preview" });
    expect(document.querySelector('a[target="_blank"]')).toBeNull();
    fireEvent.click(open);
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("keeps the inline video player and expands it into the preview", async () => {
    render(<RowRenderer row={mediaRow("video/mp4", "launch.mp4")} agentSlug="operator" />);
    const expand = await screen.findByRole("button", { name: "Open launch.mp4 in preview" });
    expect(document.querySelector("video[controls]")).toBeTruthy();
    fireEvent.click(expand);
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });
});

describe("RowRenderer — chat documents open in-app, not a new tab (#37)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const docRow = (mime: string, filename: string) =>
    row({
      kind: "chat_assistant",
      body: { text: "There you go." },
      artifacts: [{ id: "art-doc", filename, mime, bytes: 4096 }],
    });

  it("renders a pdf as a card with the filename and an Open action", async () => {
    render(<RowRenderer row={docRow("application/pdf", "competitors.pdf")} agentSlug="operator" />);
    expect(await screen.findByText("competitors.pdf")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open" })).toBeTruthy();
  });

  it("never opens a new window, and shows no emoji paperclip", () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    const { container } = render(
      <RowRenderer row={docRow("application/pdf", "competitors.pdf")} agentSlug="operator" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(open).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("📎");
    expect(container.querySelector('a[target="_blank"]')).toBeNull();
  });

  it("previews the document on the same page", async () => {
    render(<RowRenderer row={docRow("application/pdf", "competitors.pdf")} agentSlug="operator" />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("labels a markdown plan View and previews it too", async () => {
    render(<RowRenderer row={docRow("text/markdown", "growth-plan.md")} agentSlug="operator" />);
    const view = screen.getByRole("button", { name: "View" });
    fireEvent.click(view);
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("falls back to the download chip for a file Zavi cannot render", async () => {
    render(<RowRenderer row={docRow("application/zip", "bundle.zip")} agentSlug="operator" />);
    expect(await screen.findByRole("button", { name: /bundle\.zip/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
  });
});

describe("RowRenderer live-app card", () => {
  const reply = row({ kind: "chat_assistant", body: { text: "your app is up" } });

  it("shows the live-app card on the last reply", () => {
    render(<RowRenderer row={reply} agentSlug="operator" isLast />);
    expect(screen.queryByTestId("live-app-preview")).not.toBeNull();
  });

  it("never on an older reply, which may have said the app was not live yet", () => {
    render(<RowRenderer row={reply} agentSlug="operator" isLast={false} />);
    expect(screen.queryByTestId("live-app-preview")).toBeNull();
  });
});

describe("RowRenderer — data answers", () => {
  const SOURCES = "---\n**Sources.** All 2 numbers came straight from data pulled in this run.";
  const card = {
    id: "art-1",
    filename: "ui-block-1.json",
    mime: "application/vnd.zavi.ui+json",
    bytes: 100,
  };
  const wide = () =>
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("draws the Sources note under the reply, not inside it", () => {
    render(
      <RowRenderer
        row={row({ kind: "chat_assistant", body: { text: `Bookings fell.\n\n${SOURCES}` } })}
        agentSlug="operator"
      />,
    );
    expect(screen.getByTestId("bubble-assistant").textContent).toBe("Bookings fell.");
    expect(screen.getByTestId("sources-footnote").textContent).toContain("All 2 numbers");
  });

  it("splits an over-cap reply's overflow copy too, and draws the note once", () => {
    render(
      <RowRenderer
        row={row({
          kind: "chat_assistant",
          body: { text: "Bookings", fullReplyMarkdown: `Bookings fell.\n\n${SOURCES}` },
        })}
        agentSlug="operator"
      />,
    );
    expect(screen.getAllByTestId("sources-footnote")).toHaveLength(1);
  });

  it("offers Open analysis in the main chat on a wide screen", () => {
    wide();
    render(
      <ArtifactPreviewProvider>
        <RowRenderer
          row={row({ kind: "chat_assistant", body: { text: "x" }, artifacts: [card] } as never)}
          agentSlug="operator"
        />
      </ArtifactPreviewProvider>,
    );
    expect(screen.getByTestId("ui-block").dataset.canOpen).toBe("yes");
  });

  it("does not offer it inside the thread pane (flat rows)", () => {
    wide();
    render(
      <ArtifactPreviewProvider>
        <RowRenderer
          row={row({ kind: "chat_assistant", body: { text: "x" }, artifacts: [card] } as never)}
          agentSlug="operator"
          variant="flat"
        />
      </ArtifactPreviewProvider>,
    );
    expect(screen.getByTestId("ui-block").dataset.canOpen).toBe("no");
  });
});

describe("shouldAutoOpenReport", () => {
  it("opens the latest reply's report, old or new, and no other", () => {
    expect(shouldAutoOpenReport({ isLast: true }, "")).toBe(true);
    expect(shouldAutoOpenReport({ isLast: false }, "")).toBe(false);
  });

  it("stands aside for a teammate link naming a report", () => {
    expect(shouldAutoOpenReport({ isLast: true }, "?report=abc")).toBe(false);
  });
});

describe("RowRenderer inline edit", () => {
  const MESSAGE_ID = "3f1c2a4e-9b7d-4c1a-8e2f-5a6b7c8d9e0f";
  const userRow = () => row({ id: `m:${MESSAGE_ID}`, kind: "chat_user", body: { text: "hello" } });

  it("offers no Edit when the host passes no edit handler", () => {
    render(<RowRenderer row={userRow()} agentSlug="operator" />);
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("turns the bubble into an editor in place, and Cancel puts the bubble back", () => {
    render(<RowRenderer row={userRow()} agentSlug="operator" onEditMessage={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect((screen.getByLabelText("Edit message") as HTMLTextAreaElement).value).toBe("hello");
    expect(screen.queryByTestId("bubble-user")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByTestId("bubble-user").textContent).toContain("hello");
  });

  it("sends the edited text for this message", () => {
    const onEditMessage = vi.fn(async () => {});
    render(<RowRenderer row={userRow()} agentSlug="operator" onEditMessage={onEditMessage} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Edit message"), { target: { value: "hello again " } });
    fireEvent.click(send);
    expect(onEditMessage).toHaveBeenCalledWith(MESSAGE_ID, "hello again");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  });
});

describe("RowRenderer database cards (private data S6)", () => {
  it("draws the offline card from the row, and no connect card alongside it", () => {
    render(
      <RowRenderer
        row={row({
          kind: "chat_assistant",
          body: { text: "Your connector is offline." },
          connectorOffline: { machine: "mac-mini", lastSeenAt: null, retryText: "q" },
          dbNotConnected: true,
        })}
        agentSlug="operator"
        isLast
      />,
    );
    expect(screen.getByTestId("connector-offline-card")).toBeTruthy();
    expect(screen.queryByTestId("connect-database-card")).toBeNull();
  });

  it("draws the connect card when no database is connected", () => {
    render(
      <RowRenderer
        row={row({ kind: "chat_assistant", body: { text: "I need your database." }, dbNotConnected: true })}
        agentSlug="operator"
      />,
    );
    expect(screen.getByTestId("connect-database-card")).toBeTruthy();
  });
});

describe("RowRenderer — the run's narrative is above the answer", () => {
  const act = (id: string, body: Record<string, unknown>) =>
    ({ id, kind: "chat_activity", agent_run_id: "run-1", body, citations: [], created_at: "2026-10-16T00:00:00Z" }) as unknown as ChatRow;
  it("renders the sentence before the reply, and nothing after it", () => {
    const { container } = render(
      <RowRenderer
        row={row({ kind: "chat_assistant", agent_run_id: "run-1", body: { text: "the answer" } } as Partial<ChatRow> & { kind: string })}
        agentSlug="research"
        runActivity={[
          act("r1", { teKind: "reasoning", text: "Checking the ads account now." }),
          act("t1", { teKind: "tool_call", tool_name: "mcp__server__operator_db__query", target: "{}", ms: 0, code: "ok", output_preview: "" }),
          act("t2", { teKind: "tool_call", tool_name: "mcp__server__operator_db__query", target: "", ms: 0, code: "ok", output_preview: "ok" }),
        ]}
      />,
    );
    const html = container.innerHTML;
    expect(html.indexOf("Checking the ads account now.")).toBeGreaterThan(-1);
    expect(html.indexOf("Checking the ads account now.")).toBeLessThan(html.indexOf("the answer"));
    expect(html.slice(html.indexOf("the answer"))).not.toContain("Checked your database");
  });
});

describe("RowRenderer reply feedback", () => {
  const reply = (copyMarkdown: string | null | undefined) => (
    <RowRenderer
      row={row({ kind: "chat_assistant", agent_run_id: "run-9", body: { text: "the answer" } })}
      agentSlug="research"
      copyMarkdown={copyMarkdown}
    />
  );
  const feedbackRun = () => screen.getByTestId("bubble-assistant").dataset.feedbackRun;

  it("keys the thumbs to the run of the last reply in a turn", () => {
    render(reply("the answer"));
    expect(feedbackRun()).toBe("run-9");
  });

  it("gives an earlier reply in the turn no thumbs", () => {
    render(reply(null));
    expect(feedbackRun()).toBe("none");
  });

  it("gives a surface without turn copy no thumbs", () => {
    render(reply(undefined));
    expect(feedbackRun()).toBe("none");
  });

  it("hides the thumbs from a viewer, who cannot send feedback", () => {
    workspace.role = "viewer";
    render(reply("the answer"));
    expect(feedbackRun()).toBe("none");
  });
});
