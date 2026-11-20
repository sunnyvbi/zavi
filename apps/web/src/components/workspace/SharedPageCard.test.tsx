// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

const preview = { canDock: false, open: null, openArtifact: vi.fn(), close: vi.fn() };
vi.mock("./artifacts/artifactPreviewContext", () => ({ useArtifactPreview: () => preview }));

import { replyLinksAPage, SharedPageCard, SharedPagesForRun, type SharedPage } from "./SharedPageCard";
import { PAGE_MIME } from "./artifacts/artifactRender";

const ID = "22222222-2222-4222-2222-222222222222";
const base: SharedPage = {
  id: ID,
  run_id: "11111111-1111-4111-1111-111111111111",
  title: "Q3 review",
  visibility: "private",
  public_url: null,
  expires_at: null,
  created_at: "2026-09-18T00:00:00Z",
};

const json = (status: number, body: unknown) =>
  Promise.resolve({ ok: status < 400, status, json: async () => body });

beforeEach(() => {
  apiFetch.mockReset();
  preview.openArtifact.mockReset();
  preview.canDock = false;
});
afterEach(() => cleanup());

const flush = () => act(async () => {});

describe("replyLinksAPage", () => {
  it("is true only when the reply links a /pages/<uuid>", () => {
    expect(replyLinksAPage(`Here it is: https://www.zaviagent.com/pages/${ID}`)).toBe(true);
    expect(replyLinksAPage("Here is your report.")).toBe(false);
    expect(replyLinksAPage("/pages/not-a-uuid")).toBe(false);
    expect(replyLinksAPage(undefined)).toBe(false);
  });
});

describe("SharedPageCard", () => {
  it("starts private, and Make public turns it into a copyable public link", async () => {
    apiFetch.mockReturnValueOnce(
      json(200, {
        page: { ...base, visibility: "public", public_url: "https://preview.zaviagent.com/abc", expires_at: "2026-10-18T00:00:00Z" },
      }),
    );
    render(<SharedPageCard initial={base} />);
    expect(screen.getByText("Only your workspace can see this page.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open" }).getAttribute("href")).toBe(`/pages/${ID}`);

    fireEvent.click(screen.getByRole("button", { name: "Make public" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Copy public link|Link copied/ })).toBeTruthy());
    expect(apiFetch).toHaveBeenCalledWith(`/api/workspace/shared-pages/${ID}/publish`, { method: "POST" });
    expect(screen.getByText(/Anyone with the link can open it until/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Revoke" })).toBeTruthy();
  });

  it("shows the server's reason when publishing is refused", async () => {
    apiFetch.mockReturnValueOnce(
      json(422, { error: { message: "This page contains something that looks like a key or token, so it can't be made public." } }),
    );
    render(<SharedPageCard initial={base} />);
    fireEvent.click(screen.getByRole("button", { name: "Make public" }));
    await waitFor(() => expect(screen.getByText(/looks like a key or token/)).toBeTruthy());
    expect(screen.getByRole("button", { name: "Make public" })).toBeTruthy();
  });
});

describe("SharedPageCard shape", () => {
  it("carries the 16px card radius and 10px buttons the build cards use, not the 8px/6px chip shape", () => {
    render(<SharedPageCard initial={{ ...base, visibility: "public", public_url: "https://www.zaviagent.com/pages/x" }} />);
    const card = screen.getByText("Q3 review").closest("div.flex-col") as HTMLElement;
    expect(card.className).toMatch(/(?:^|\s)rounded-\[16px\](?:\s|$)/);
    expect(card.className).not.toMatch(/(?:^|\s)rounded-lg(?:\s|$)/);
    for (const name of ["Open", "Copy public link", "Revoke"]) {
      const btn = screen.getByRole(name === "Open" ? "link" : "button", { name });
      expect(btn.className, name).toMatch(/(?:^|\s)rounded-cta(?:\s|$)/);
    }
  });
});

describe("SharedPageCard Open", () => {
  it("docks the page beside the chat when the surface can dock, and never renders a new-tab anchor", () => {
    preview.canDock = true;
    render(<SharedPageCard initial={base} />);
    expect(screen.queryByRole("link", { name: "Open" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(preview.openArtifact).toHaveBeenCalledTimes(2);
    const request = preview.openArtifact.mock.calls[0][0];
    expect(request.artifact).toMatchObject({
      id: ID,
      run_id: base.run_id,
      title: "Q3 review",
      filename: "Q3 review",
      mime: PAGE_MIME,
      type: "website",
      preview_url: `/pages/${ID}`,
      source: { kind: "chat", id: base.run_id, href: `/pages/${ID}` },
    });

    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    request.onDownload();
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(`/pages/${ID}`, "_blank", "noopener,noreferrer");
    open.mockRestore();
  });

  it("falls back to a new tab when the surface cannot dock", () => {
    render(<SharedPageCard initial={base} />);
    const link = screen.getByRole("link", { name: "Open" });
    expect(link.getAttribute("href")).toBe(`/pages/${ID}`);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
    fireEvent.click(link);
    expect(preview.openArtifact).not.toHaveBeenCalled();
  });
});

describe("SharedPagesForRun autoOpen", () => {
  const RUN = base.run_id;
  const second: SharedPage = { ...base, id: "33333333-3333-4333-3333-333333333333", title: "Appendix" };
  const pagesResponse = () => json(200, { pages: [{ ...base }, { ...second }] });

  it("docks the first page exactly once per run, surviving a re-render, a second fetch, and the pane being closed", async () => {
    preview.canDock = true;
    apiFetch.mockImplementation(pagesResponse);
    const { rerender } = render(
      <StrictMode>
        <SharedPagesForRun runId={RUN} autoOpen />
      </StrictMode>,
    );
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Open" })).toHaveLength(2));
    expect(apiFetch.mock.calls.length).toBeGreaterThanOrEqual(2);
    await flush();

    rerender(
      <StrictMode>
        <SharedPagesForRun runId={RUN} autoOpen />
      </StrictMode>,
    );
    await flush();
    preview.canDock = false;
    rerender(
      <StrictMode>
        <SharedPagesForRun runId={RUN} autoOpen />
      </StrictMode>,
    );
    await flush();
    preview.canDock = true;
    rerender(
      <StrictMode>
        <SharedPagesForRun runId={RUN} autoOpen />
      </StrictMode>,
    );
    await flush();

    expect(preview.openArtifact).toHaveBeenCalledTimes(1);
    expect(preview.openArtifact.mock.calls[0][0].artifact).toMatchObject({ id: ID, mime: PAGE_MIME, preview_url: `/pages/${ID}` });
  });

  it("opens again for a different run", async () => {
    preview.canDock = true;
    apiFetch.mockImplementation(pagesResponse);
    const { rerender } = render(<SharedPagesForRun runId={RUN} autoOpen />);
    await waitFor(() => expect(preview.openArtifact).toHaveBeenCalledTimes(1));
    rerender(<SharedPagesForRun runId="44444444-4444-4444-4444-444444444444" autoOpen />);
    await waitFor(() => expect(preview.openArtifact).toHaveBeenCalledTimes(2));
  });

  it("never docks when the surface cannot dock", async () => {
    apiFetch.mockImplementation(pagesResponse);
    render(<SharedPagesForRun runId={RUN} autoOpen />);
    await waitFor(() => expect(screen.getAllByRole("link", { name: "Open" })).toHaveLength(2));
    await flush();
    expect(preview.openArtifact).not.toHaveBeenCalled();
  });

  it("never docks when autoOpen is off", async () => {
    preview.canDock = true;
    apiFetch.mockImplementation(pagesResponse);
    render(<SharedPagesForRun runId={RUN} />);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Open" })).toHaveLength(2));
    await flush();
    expect(preview.openArtifact).not.toHaveBeenCalled();
  });
});
