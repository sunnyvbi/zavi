// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { adminApiFetch } = vi.hoisted(() => ({ adminApiFetch: vi.fn() }));
vi.mock("@/lib/api-admin", () => ({ adminApiFetch }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: unknown }) => <a href={href}>{children as never}</a> }));

import { TeamNotesPage } from "./TeamNotesView";

const ok = (b: unknown) => ({ ok: true, status: 200, json: async () => b });
const meta = (id: string, name: string) => ({
  id, tenant_id: "t1", tenant_slug: name.toLowerCase(), tenant_name: name, agent_slug: "operator", signal: "other",
  source: "run_end", created_at: "2026-10-18T10:00:00Z", has_extra: false, note_edited: false, status: "new",
  thread_id: null, message_id: null,
});
const detail = (id: string, note: string) => ({
  report: { id, tenant_id: "t1", agent_slug: "operator", signal: "other", source: "run_end",
    created_at: "2026-10-18T10:00:00Z", note, founder_extra: null, thread_path: null },
});
const summary = { days: 7, totals: { judged: 0, judged_bad: 0, judge_failed: 0, offered: 0, strips: 0, flags: 0, sent: 0, dismissed: 0 }, judgements: [], offers: [] };

function serve(details: Record<string, () => Promise<unknown>>) {
  adminApiFetch.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/admin/team-notes/summary")) return ok(summary);
    if (path === "/api/admin/team-notes/reports") return ok({ reports: [meta("a", "Alpha"), meta("b", "Beta")], next_cursor: null });
    const id = path.split("/").pop()!;
    return ok(await details[id]());
  });
}
const readButtons = async () => screen.findAllByRole("button", { name: "Read" });

afterEach(() => { cleanup(); adminApiFetch.mockReset(); });

describe("TeamNotesPage report drawer", () => {
  it("A -> close -> B: B's drawer never shows A's text, not even while B loads", async () => {
    let releaseB: () => void = () => {};
    const bReady = new Promise<void>((r) => { releaseB = r; });
    serve({ a: async () => detail("a", "Note A text"), b: async () => { await bReady; return detail("b", "Note B text"); } });
    render(<TeamNotesPage />);
    const [readA, readB] = await readButtons();
    fireEvent.click(readA);
    await screen.findByText("Note A text");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(readB);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.queryByText("Note A text")).toBeNull();
    expect(screen.getByRole("dialog").textContent).toContain("Loading…");
    releaseB();
    await screen.findByText("Note B text");
    expect(screen.queryByText("Note A text")).toBeNull();
  });

  it("A answers late, after B was opened: A's text is dropped", async () => {
    let releaseA: () => void = () => {};
    const aReady = new Promise<void>((r) => { releaseA = r; });
    serve({ a: async () => { await aReady; return detail("a", "Note A text"); }, b: async () => detail("b", "Note B text") });
    render(<TeamNotesPage />);
    const [readA, readB] = await readButtons();
    fireEvent.click(readA);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(readB);
    await screen.findByText("Note B text");
    releaseA();
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText("Note A text")).toBeNull();
    expect(screen.getByText("Note B text")).toBeTruthy();
  });

  it("a detail error shows in the drawer, and reopening fetches again", async () => {
    let calls = 0;
    adminApiFetch.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/admin/team-notes/summary")) return ok(summary);
      if (path === "/api/admin/team-notes/reports") return ok({ reports: [meta("a", "Alpha")], next_cursor: null });
      calls += 1;
      return calls === 1
        ? { ok: false, status: 503, json: async () => ({ error: { message: "Could not record this read" } }) }
        : ok(detail("a", "Note A text"));
    });
    render(<TeamNotesPage />);
    const [readA] = await readButtons();
    fireEvent.click(readA);
    await screen.findByText("Could not record this read");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(readA);
    await waitFor(() => expect(screen.getByText("Note A text")).toBeTruthy());
  });
});
