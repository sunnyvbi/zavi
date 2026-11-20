// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactViewer } from "./ArtifactViewer";
import { PAGE_MIME } from "./artifactRender";
import type { Artifact } from "./types";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch }));

const SIGNED = "https://storage.example/signed/draft.html?token=abc";

function artifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: "artifact-1",
    run_id: "run-1",
    title: "Car Rental Delivered to Your Door",
    filename: "car-rental-delivery.html",
    mime: "text/html",
    type: "website",
    bytes: 7700,
    created_at: "2026-09-14T10:00:00Z",
    updated_at: "2026-09-14T10:00:00Z",
    preview_url: SIGNED,
    source: { kind: "task", id: "run-1", title: "Seo task", href: "/workspace/runs/run-1" },
    ...overrides,
  };
}

beforeEach(() => {
  apiFetch.mockReset();
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ArtifactViewer", () => {
  it("renders an HTML artifact's own bytes in a locked-down frame", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      text: async () => "<!doctype html><h1>Delivered to your door</h1>",
    });

    render(<ArtifactViewer artifact={artifact()} onClose={vi.fn()} onDownload={vi.fn()} />);

    const frame = await waitFor(() => {
      const element = document.querySelector("iframe");
      expect(element).not.toBeNull();
      return element as HTMLIFrameElement;
    });

    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("src")).toBeNull();
    expect(frame.getAttribute("srcdoc")).toContain("default-src 'none'");
    expect(frame.getAttribute("srcdoc")).toContain("Delivered to your door");

    expect(globalThis.fetch).toHaveBeenCalledWith(SIGNED, expect.objectContaining({ signal: expect.anything() }));
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("mints a fresh URL only when the list's has aged out", async () => {
    const fresh = "https://storage.example/signed/fresh.html?token=zzz";
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400 });
    apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ signed_url: fresh }) });
    fetchMock.mockResolvedValueOnce({ ok: true, text: async () => "<p>fresh</p>" });

    render(<ArtifactViewer artifact={artifact()} onClose={vi.fn()} onDownload={vi.fn()} />);

    await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
    expect(apiFetch).toHaveBeenCalledWith(
      "/api/run-artifacts/artifact-1/url",
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(2, fresh, expect.anything());
  });

  it("retries once past a transient sign_failed", async () => {
    apiFetch
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ signed_url: SIGNED }) });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      text: async () => "<p>recovered</p>",
    });

    render(
      <ArtifactViewer
        artifact={artifact({ preview_url: null })}
        onClose={vi.fn()}
        onDownload={vi.fn()}
      />,
    );

    const frame = await waitFor(
      () => {
        const element = document.querySelector("iframe");
        expect(element).not.toBeNull();
        return element as HTMLIFrameElement;
      },
      { timeout: 4000 },
    );
    expect(frame.getAttribute("srcdoc")).toContain("recovered");
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it("never offers to open an HTML artifact on the storage origin", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      text: async () => "<p>hi</p>",
    });
    render(<ArtifactViewer artifact={artifact()} onClose={vi.fn()} onDownload={vi.fn()} />);
    await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
    expect(screen.queryByLabelText(/Open .* in a new tab/)).toBeNull();
  });

  it("opens as a large centred dialog", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      text: async () => "<p>hi</p>",
    });
    render(<ArtifactViewer artifact={artifact()} onClose={vi.fn()} onDownload={vi.fn()} />);
    const panel = await screen.findByRole("dialog");
    expect(panel.getAttribute("aria-modal")).toBe("true");
    expect(panel.className).toContain("h-[88dvh]");
    expect(panel.className).toContain("max-h-full");
    expect(panel.className).toContain("max-w-6xl");
    expect(panel.parentElement?.className).toContain("items-center");
  });

  it("closes on a backdrop press, but not on one that began inside the render", async () => {
    const onClose = vi.fn();
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      text: async () => "<p>hi</p>",
    });
    render(<ArtifactViewer artifact={artifact()} onClose={onClose} onDownload={vi.fn()} />);
    const panel = await screen.findByRole("dialog");
    fireEvent.pointerDown(panel);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(panel.parentElement as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("offers the storage tab for a PDF, which the browser renders safely there", async () => {
    render(
      <ArtifactViewer
        artifact={artifact({ mime: "application/pdf", filename: "report.pdf", type: "document" })}
        onClose={vi.fn()}
        onDownload={vi.fn()}
      />,
    );
    const link = await screen.findByLabelText(/in a new tab/);
    expect(link.getAttribute("href")).toBe(SIGNED);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("draws a CSV on one line per cell, long cells cut with the full text on hover, first column pinned", async () => {
    const long = "Partner at a fund that invests in seed-stage marketplaces across North America and Europe";
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      text: async () => `Name,Notes\nAda Lovelace,"${long}"\n`,
    });
    render(
      <ArtifactViewer
        artifact={artifact({ mime: "text/csv", filename: "investors.csv", bytes: 120 })}
        onClose={vi.fn()}
        onDownload={vi.fn()}
      />,
    );
    const cell = await screen.findByTitle(long);
    expect(cell.className).toContain("whitespace-nowrap");
    expect(cell.querySelector("div")?.className).toContain("truncate");
    const first = screen.getByTitle("Ada Lovelace");
    expect(first.className).toContain("sticky");
    expect(first.className).toContain("left-0");
    expect(screen.getByTestId("csv-table").className).toContain("overflow-auto");
  });

  it("offers the download instead of freezing the tab on an oversized file", async () => {
    const onDownload = vi.fn();
    render(
      <ArtifactViewer
        artifact={artifact({ mime: "text/csv", filename: "events.csv", bytes: 40 * 1024 * 1024 })}
        onClose={vi.fn()}
        onDownload={onDownload}
      />,
    );
    fireEvent.click(await screen.findByText("Download instead"));
    expect(onDownload).toHaveBeenCalledTimes(1);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("does not reload when the list re-signs the same artifact", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: async () => "<p>stable</p>",
    });
    const { rerender } = render(
      <ArtifactViewer artifact={artifact()} onClose={vi.fn()} onDownload={vi.fn()} />,
    );
    await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    rerender(
      <ArtifactViewer
        artifact={artifact({ preview_url: `${SIGNED}&resigned=1` })}
        onClose={vi.fn()}
        onDownload={vi.fn()}
      />,
    );
    await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(document.querySelector("iframe")?.getAttribute("srcdoc")).toContain("stable");
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, text: async () => "" });
    render(<ArtifactViewer artifact={artifact()} onClose={onClose} onDownload={vi.fn()} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps Escape from reaching document listeners (a run's cancel key)", () => {
    const onClose = vi.fn();
    const documentListener = vi.fn();
    document.addEventListener("keydown", documentListener);
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, text: async () => "" });
    render(<ArtifactViewer artifact={artifact()} onClose={onClose} onDownload={vi.fn()} />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    document.removeEventListener("keydown", documentListener);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(documentListener).not.toHaveBeenCalled();
  });

  it("frames a shared page straight from its same-origin path without touching the API", async () => {
    const page = artifact({
      id: "page-1",
      title: "Q3 launch tracker",
      filename: "index.html",
      mime: PAGE_MIME,
      type: "website",
      bytes: 0,
      preview_url: "/pages/0d3b9f1e-2c4a-4f6b-9a1d-7e8c5b2a1f00",
    });
    render(<ArtifactViewer artifact={page} onClose={vi.fn()} onDownload={vi.fn()} />);

    const frame = document.querySelector("iframe") as HTMLIFrameElement | null;
    expect(frame).not.toBeNull();
    expect(frame?.getAttribute("src")).toBe("/pages/0d3b9f1e-2c4a-4f6b-9a1d-7e8c5b2a1f00");
    expect(frame?.getAttribute("srcdoc")).toBeNull();
    expect(frame?.getAttribute("title")).toBe("Q3 launch tracker");
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin allow-popups");
    expect(screen.queryByRole("status")).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(apiFetch).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(screen.queryByText("Unknown size")).toBeNull();
    expect(screen.queryByText("0 B")).toBeNull();
    expect(screen.queryByLabelText(/in a new tab/)).toBeNull();
  });

  it("tells the reader when a shared page has been taken down instead of framing nothing", async () => {
    render(
      <ArtifactViewer
        artifact={artifact({ mime: PAGE_MIME, filename: "index.html", bytes: 0, preview_url: null })}
        onClose={vi.fn()}
        onDownload={vi.fn()}
      />,
    );
    expect(await screen.findByText("This page is no longer available.")).toBeTruthy();
    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.queryByText("Download instead")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("keeps keyboard focus inside the modal", async () => {
    render(
      <>
        <button type="button">Outside</button>
        <ArtifactViewer
          artifact={artifact({
            mime: "application/octet-stream",
            filename: "archive.bin",
          })}
          onClose={vi.fn()}
          onDownload={vi.fn()}
        />
      </>,
    );

    const dialog = await screen.findByRole("dialog");
    const outside = screen.getByRole("button", { name: "Outside" });
    outside.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});
