// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

type Tab = { id: string; kind: string; payload: Record<string, unknown> };
type Ws = { tabs: Tab[]; openTab: (d: { kind: string; payload: Record<string, unknown> }) => string; role: string };
const opened: Array<{ kind: string; payload: Record<string, unknown> }> = [];
const Ctx = createContext<Ws | null>(null);

vi.mock("./WorkspaceShell", () => ({
  useWorkspace: () => useContext(Ctx)!,
  useWorkspaceOptional: () => useContext(Ctx),
}));
vi.mock("@/lib/workspace/unappliedEdits", () => ({ guardLeave: (fn: () => void) => fn() }));

function Shell({ children }: { children: ReactNode }) {
  const [tabs, setTabs] = useState<Tab[]>([
    { id: "ny", kind: "needs-you", payload: { kind: "needs-you", decision: D } },
    { id: "ch", kind: "channels", payload: { kind: "channels" } },
  ]);
  const openTab = useCallback(
    (d: { kind: string; payload: Record<string, unknown> }) => {
      opened.push(d);
      const existing = tabs.find((t) => t.kind === d.kind);
      if (existing) {
        setTabs((prev) => prev.map((t) => (t.id === existing.id ? { ...t, payload: d.payload } : t)));
        return existing.id;
      }
      const id = `t${tabs.length}`;
      setTabs((prev) => [...prev, { id, kind: d.kind, payload: d.payload }]);
      return id;
    },
    [tabs],
  );
  return <Ctx.Provider value={{ tabs, openTab, role: "owner" }}>{children}</Ctx.Provider>;
}

import { NeedsYouTab } from "./NeedsYouTab";

const D = "11111111-2222-4333-8444-555555555555";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const detailGets = () => apiFetch.mock.calls.filter(([u, init]) => u === `/api/approvals/${D}` && (!init || !(init as RequestInit).method || (init as RequestInit).method === "GET")).length;

beforeEach(() => {
  opened.length = 0;
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (url: string) => {
    await new Promise((r) => setTimeout(r, 10));
    if (url === `/api/approvals/${D}`)
      return json(200, {
        decision: {
          id: D,
          decision_class: "email_campaign.create_and_send",
          handler: "email_campaign.create_and_send",
          body: {},
          status: "acted",
          emitted_at: "2026-10-28T10:00:00.000Z",
        },
        home: { kind: "channel", slug: "email_marketing" },
        needs_owner_admin: false,
        viewer_role: "owner",
      });
    if (url.startsWith("/api/approvals?home=needs_you"))
      return json(200, { decisions: [], next_cursor: null, totals: { needs_you: 0, growth: 0, channel: 0 } });
    return json(404, { error: { code: "not_found" } });
  });
});
afterEach(cleanup);

describe("NeedsYouTab focus on a channel decision", () => {
  it("reads the decision once and opens its channel once, while the tab stays mounted and the shell's openTab changes", async () => {
    render(
      <Shell>
        <NeedsYouTab isActive={false} focusDecisionId={D} />
      </Shell>,
    );
    for (let i = 0; i < 40; i++) await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    expect(opened).toEqual([{ kind: "channels", title: "Growth Channels", payload: { kind: "channels", channel: "email_marketing", action: D }, dirty: false, pinned: false }]);
    expect(detailGets()).toBe(1);
  });
});
