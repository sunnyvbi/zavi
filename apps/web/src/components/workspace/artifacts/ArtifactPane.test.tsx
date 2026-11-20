// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { ArtifactPane, ARTIFACT_PANE_DEFAULT_PX, ARTIFACT_PANE_MIN_PX, PANE_MAXIMIZE_MS } from "./ArtifactPane";
import type { Artifact } from "./types";

vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async () => ({
    ok: true,
    json: async () => ({ signed_url: "https://storage.example/signed/doc.pdf" }),
  })),
}));

const artifact = (over: Partial<Artifact> = {}): Artifact => ({
  id: "art-doc",
  run_id: "",
  title: "competitors.pdf",
  filename: "competitors.pdf",
  mime: "application/pdf",
  type: "document",
  bytes: 4096,
  created_at: "2026-09-18T10:00:00.000Z",
  updated_at: "2026-09-18T10:00:00.000Z",
  preview_url: null,
  source: { kind: "chat", id: "", title: "", href: "" },
  ...over,
});

function renderPane(over: Partial<Artifact> = {}) {
  const onClose = vi.fn();
  const onDownload = vi.fn();
  const containerRef = createRef<HTMLElement>();
  const utils = render(
    <ArtifactPane
      artifact={artifact(over)}
      onClose={onClose}
      onDownload={onDownload}
      containerRef={containerRef}
    />,
  );
  return { onClose, onDownload, ...utils };
}

describe("ArtifactPane (#37)", () => {
  afterEach(cleanup);

  it("docks as a labelled complementary region with the filename", () => {
    renderPane();
    const pane = screen.getByRole("complementary", { name: "Document preview" });
    expect(pane).toBeTruthy();
    expect(pane.textContent).toContain("competitors.pdf");
  });

  it("opens at its default width and never narrower than the minimum", () => {
    const { container } = renderPane();
    const pane = container.querySelector('[data-testid="artifact-pane"]') as HTMLElement;
    expect(pane.style.width).toBe(`${ARTIFACT_PANE_DEFAULT_PX}px`);
    expect(ARTIFACT_PANE_DEFAULT_PX).toBeGreaterThan(ARTIFACT_PANE_MIN_PX);
  });

  it("is resizable — the hook's separator is wired up", () => {
    const { container } = renderPane();
    const handle = container.querySelector('[data-testid="artifact-pane-resizer"]');
    expect(handle).toBeTruthy();
    expect(handle?.getAttribute("role")).toBe("separator");
    expect(handle?.getAttribute("aria-label")).toBe("Resize document preview");
  });

  it("closes on the Close button and on Escape", () => {
    const { onClose } = renderPane();
    fireEvent.click(screen.getByRole("button", { name: "Close document preview" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    const second = renderPane();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(second.onClose).toHaveBeenCalledTimes(1);
  });

  it("stops Escape from reaching the chat surface, which would cancel the run", () => {
    const surface = vi.fn();
    window.addEventListener("keydown", surface);
    renderPane();
    fireEvent.keyDown(window, { key: "Escape" });
    window.removeEventListener("keydown", surface);
    expect(surface).not.toHaveBeenCalled();
  });

  it("animates to fill the row and back to its docked width", () => {
    vi.useFakeTimers();
    const { container } = renderPane();
    const pane = container.querySelector('[data-testid="artifact-pane"]') as HTMLElement;
    fireEvent.click(screen.getByRole("button", { name: "Maximize preview" }));
    expect(pane.dataset.maximized).toBe("true");
    expect(pane.style.width).toBe("");
    expect(pane.style.transition).toContain(`left ${PANE_MAXIMIZE_MS}ms`);
    expect(container.querySelector('[data-testid="artifact-pane-resizer"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Minimize preview" }));
    expect(pane.dataset.maximized).toBeUndefined();
    expect(pane.style.width).toBe("");
    act(() => {
      vi.advanceTimersByTime(PANE_MAXIMIZE_MS);
    });
    expect(pane.style.width).toBe(`${ARTIFACT_PANE_DEFAULT_PX}px`);
    expect(container.querySelector('[data-testid="artifact-pane-resizer"]')).toBeTruthy();
    vi.useRealTimers();
  });

  it("titles the header with the open document's own title", () => {
    renderPane({ title: "Q3 competitor review" });
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Q3 competitor review");
  });

  it("falls back to the filename when the document has no title", () => {
    renderPane({ title: "  " });
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("competitors.pdf");
  });

  it("downloads the open document from the download menu", () => {
    const { onDownload } = renderPane();
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    const item = screen.getByRole("menuitem", { name: /competitors\.pdf/ });
    expect(item.textContent).toContain("4.0 KB");
    fireEvent.click(item);
    expect(onDownload).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes the download menu on Escape without closing the pane", () => {
    const { onClose } = renderPane();
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("renders a markdown document as formatted content, not a download prompt", async () => {
    renderPane({ filename: "plan.md", mime: "text/markdown", title: "plan.md" });
    expect(await screen.findByRole("status", { name: /Loading plan\.md/ })).toBeTruthy();
    expect(screen.queryByText(/can’t display/)).toBeNull();
  });
});

describe("ArtifactPane — auto-open manners", () => {
  afterEach(cleanup);

  it("leaves focus in the composer when it opened by itself", () => {
    const box = document.createElement("textarea");
    document.body.appendChild(box);
    box.focus();
    render(<ArtifactPane artifact={artifact()} onClose={vi.fn()} onDownload={vi.fn()} containerRef={createRef<HTMLElement>()} autoOpened />);
    expect(document.activeElement).toBe(box);
    box.remove();
  });

  it("ignores Escape while it is hidden in a background tab", () => {
    const onClose = vi.fn();
    render(
      <div style={{ display: "none" }}>
        <ArtifactPane artifact={artifact()} onClose={onClose} onDownload={vi.fn()} containerRef={createRef<HTMLElement>()} />
      </div>,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
