import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/api-admin", () => ({ adminApiFetch: vi.fn() }));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: unknown }) => <a href={href} {...p}>{children as never}</a> }));

import { ReportDrawer, ReportsList, SummaryView, TeamNotesPage, type ReportMeta, type Summary } from "./TeamNotesView";

const summary: Summary = {
  days: 7,
  totals: { judged: 9, judged_bad: 3, judge_failed: 1, offered: 3, strips: 2, flags: 1, sent: 2, dismissed: 1 },
  judgements: [{ agent_slug: "operator", code_signal: "run_failed", judge_signal: "other", source: "run_end", surface: "strip", verdict: "bad", n: 3 }],
  offers: [],
};
const report = (over: Partial<ReportMeta> = {}): ReportMeta => ({
  id: "r1", tenant_id: "t1", tenant_slug: "acme", tenant_name: "Acme", agent_slug: "operator", signal: "tool_failure",
  source: "run_end", created_at: "2026-10-18T10:00:00Z", has_extra: true, note_edited: false, status: "new",
  thread_id: "th1", message_id: "m1", ...over,
});
const noop = () => {};

describe("TeamNotesView", () => {
  it("the page starts loading both sections", () => {
    const html = renderToStaticMarkup(<TeamNotesPage />);
    expect(html).toContain("Team notes");
    expect(html.match(/Loading…/g)?.length).toBe(2);
    expect(html).toContain("7 days");
    expect(html).toContain("30 days");
  });

  it("summary: totals tiles, a count table, and an empty state for an empty table", () => {
    const html = renderToStaticMarkup(<SummaryView state={{ kind: "ready", data: summary }} />);
    expect(html).toContain("Judged bad");
    expect(html).toContain("run_failed");
    expect(html).toContain("No notes drafted in this window.");
  });

  it("summary error state", () => {
    expect(renderToStaticMarkup(<SummaryView state={{ kind: "error", message: "not_staff" }} />)).toContain("not_staff");
  });

  it("reports: metadata rows, Load more only with a cursor, and an empty state", () => {
    const html = renderToStaticMarkup(
      <ReportsList state={{ kind: "ready", data: { reports: [report()], next_cursor: { before: "x", before_id: "y" } } }}
        onOpen={noop} onMore={noop} loadingMore={false} />);
    expect(html).toContain("Acme");
    expect(html).toContain("tool_failure");
    expect(html).toContain("Load more");
    const last = renderToStaticMarkup(
      <ReportsList state={{ kind: "ready", data: { reports: [report({ tenant_name: null })], next_cursor: null } }}
        onOpen={noop} onMore={noop} loadingMore={false} />);
    expect(last).not.toContain("Load more");
    expect(last).toContain("acme");
    expect(renderToStaticMarkup(<ReportsList state={{ kind: "ready", data: { reports: [], next_cursor: null } }}
      onOpen={noop} onMore={noop} loadingMore={false} />)).toContain("No founder has sent a report yet.");
    expect(renderToStaticMarkup(<ReportsList state={{ kind: "error", message: "boom" }}
      onOpen={noop} onMore={noop} loadingMore={false} />)).toContain("boom");
  });

  it("drawer: loading, error, the note with a chat link, and a deleted chat", () => {
    expect(renderToStaticMarkup(<ReportDrawer state={{ kind: "loading" }} onClose={noop} />)).toContain("Loading…");
    expect(renderToStaticMarkup(<ReportDrawer state={{ kind: "error", message: "Could not record this read" }} onClose={noop} />))
      .toContain("Could not record this read");
    const base = { id: "r1", tenant_id: "t1", agent_slug: "operator", signal: "other", source: "run_end", created_at: "2026-10-18T10:00:00Z" };
    const ready = renderToStaticMarkup(<ReportDrawer onClose={noop}
      state={{ kind: "ready", data: { ...base, note: "The tool failed.", founder_extra: "Also Tuesday.", thread_path: "/tenants/t1/threads/th1" } }} />);
    expect(ready).toContain("The tool failed.");
    expect(ready).toContain("Also Tuesday.");
    expect(ready).toContain('href="/tenants/t1/threads/th1"');
    expect(ready).toContain("recorded in the audit log");
    const gone = renderToStaticMarkup(<ReportDrawer onClose={noop}
      state={{ kind: "ready", data: { ...base, note: "n", founder_extra: null, thread_path: null } }} />);
    expect(gone).toContain("The chat was deleted.");
    expect(gone).not.toContain("Founder added");
  });
});
