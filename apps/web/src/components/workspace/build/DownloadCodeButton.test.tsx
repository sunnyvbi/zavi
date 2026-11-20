// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DownloadCodeButton } from "./DownloadCodeButton";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

const clicks: string[] = [];
beforeEach(() => {
  URL.createObjectURL = vi.fn(() => "blob:zip");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    clicks.push(this.download);
  });
});
afterEach(() => {
  cleanup();
  apiFetch.mockReset();
  clicks.length = 0;
  vi.restoreAllMocks();
});

function zipReply(filename: string) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-disposition": `attachment; filename="${filename}"` }),
    blob: async () => new Blob(["PK"]),
  };
}

describe("DownloadCodeButton", () => {
  it("downloads the ZIP of the site in view, named by the server", async () => {
    apiFetch.mockResolvedValue(zipReply("site-93bd8436.zip"));
    render(<DownloadCodeButton sessionId="sess-1" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /download zip/i }));
    });
    expect(apiFetch).toHaveBeenCalledWith("/api/workspace/app-code/zip?build_session_id=sess-1");
    expect(clicks).toEqual(["site-93bd8436.zip"]);
    expect((screen.getByRole("button", { name: /download zip/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("asks for the workspace app when no Build session is open", async () => {
    apiFetch.mockResolvedValue(zipReply("app.zip"));
    render(<DownloadCodeButton sessionId={null} variant="compact" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /download/i }));
    });
    expect(apiFetch).toHaveBeenCalledWith("/api/workspace/app-code/zip?app=workspace");
  });

  it("shows the server's message when the download is refused", async () => {
    apiFetch.mockResolvedValue({
      ok: false,
      status: 413,
      headers: new Headers(),
      json: async () => ({ error: { message: "This app is too large to download here. Export it to GitHub instead." } }),
    });
    render(<DownloadCodeButton sessionId="sess-1" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /download zip/i }));
    });
    expect(screen.getByRole("alert").textContent).toContain("too large");
    expect(clicks).toEqual([]);
  });

  it("says so when the network fails, and a retry works", async () => {
    apiFetch.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(zipReply("app.zip"));
    render(<DownloadCodeButton sessionId="sess-1" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /download zip/i }));
    });
    expect(screen.getByRole("alert").textContent).toContain("connection");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /download zip/i }));
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(clicks).toEqual(["app.zip"]);
  });
});
