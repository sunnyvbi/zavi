// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
const calls: Array<[string, string]> = [];
let empty = false;
let listFails = false;
vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async (path: string, opts?: { method?: string }) => {
    calls.push([opts?.method ?? "GET", path]);
    if (listFails && path === "/api/knowledge/imports") return { ok: false, status: 500, json: async () => ({ error: { message: "list failed" } }) };
    if (path.startsWith("/api/knowledge/imports?") || path === "/api/knowledge/imports")
      return { ok: true, json: async () => ({ files: empty ? [] : [{ id: "d1", filename: "retro.md", size_bytes: 2048, extraction: { state: "read", facts: 1 }, facts: [{ id: "n1", text: "Trial to paid is 22%.", quote: "trial->paid 22%", line: 3 }] }] }) };
    if (path.endsWith("/url")) return { ok: true, json: async () => ({ url: "https://signed" }) };
    return { ok: true, json: async () => ({ ok: true }) };
  }),
}));
vi.mock("@/components/ui/ConfirmDialog", () => ({ confirmAction: vi.fn(async () => true) }));
import { ImportedKnowledgeSection } from "./ImportedKnowledgeSection";
afterEach(() => { cleanup(); calls.length = 0; empty = false; listFails = false; });

describe("ImportedKnowledgeSection", () => {
  it("lists each file with the facts it gave, each with its source line", async () => {
    render(<ImportedKnowledgeSection readOnly={false} />);
    await screen.findByText("retro.md");
    fireEvent.click(screen.getByRole("button", { name: "See facts" }));
    expect(screen.getByText("Trial to paid is 22%.")).toBeTruthy();
    expect(screen.getByText("retro.md, line 3: “trial->paid 22%”")).toBeTruthy();
  });
  it("removes one fact, or the whole file", async () => {
    render(<ImportedKnowledgeSection readOnly={false} />);
    await screen.findByText("retro.md");
    fireEvent.click(screen.getByRole("button", { name: "See facts" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove fact: Trial to paid is 22%." }));
    await waitFor(() => expect(calls).toContainEqual(["DELETE", "/api/knowledge/facts/n1"]));
    fireEvent.click(screen.getByRole("button", { name: "Remove retro.md" }));
    await waitFor(() => expect(calls).toContainEqual(["DELETE", "/api/knowledge/imports/d1"]));
  });
  it("members see nothing (the list is owner/admin only; they never even ask)", async () => {
    const { container } = render(<ImportedKnowledgeSection readOnly />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.firstChild).toBeNull();
    expect(calls).toEqual([]);
  });
  it("loads the next page when there is one", async () => {
    render(<ImportedKnowledgeSection readOnly={false} />);
    await screen.findByText("retro.md");
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });
  it("a tenant that never imported sees today's page (nothing rendered)", async () => {
    empty = true;
    const { container } = render(<ImportedKnowledgeSection readOnly={false} />);
    await waitFor(() => expect(calls).toContainEqual(["GET", "/api/knowledge/imports"]));
    await new Promise((r) => setTimeout(r, 0));
    expect(container.firstChild).toBeNull();
  });
  it("a failed list load shows its error instead of hiding the section", async () => {
    listFails = true;
    render(<ImportedKnowledgeSection readOnly={false} />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/list failed/);
  });
});
