// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TabDescriptor } from "@/lib/workspace/types";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
  }),
}));

const NOW = Date.parse("2026-10-13T12:00:00Z");
const noteRow = (id: string, title: string, minutesAgo: number) => ({
  id,
  title,
  body_markdown: title,
  source: "operator_feedback",
  source_ref: null,
  tags: [],
  note_type: "tenant_reference",
  slug: null,
  created_at: new Date(NOW - minutesAgo * 60_000).toISOString(),
  updated_at: new Date(NOW - minutesAgo * 60_000).toISOString(),
});

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  apiFetch,
}));

const ctx = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("@/components/workspace/WorkspaceShell", async (orig) => ({
  ...(await orig<typeof import("@/components/workspace/WorkspaceShell")>()),
  useWorkspace: () => ctx.value,
}));

import { middleware } from "@/middleware";
import { NextRequest } from "next/server";
import { RememberedPill } from "./RememberedPill";
import { __resetMemoryWritesCache } from "@/lib/memory/useMemoryWrites";
import type { MemoryApi } from "@/lib/memory/writesApi";
import { resolveWorkspaceTab, workspaceTabHref } from "@/components/workspace/navigation/workspaceRoutes";
import { WorkspacePane } from "@/components/workspace/WorkspacePane";
import MemoryPage from "@/app/memory/page";

const flush = () => act(async () => {});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://wmyc.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-test-key";
  vi.useFakeTimers({ now: NOW, toFake: ["setTimeout", "clearTimeout", "Date"] });
  window.localStorage.setItem("zavi.memory.lastVisitAt", String(NOW));
  __resetMemoryWritesCache();
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (path: string) => {
    if (path === "/api/memory/notes")
      return json({
        notes: [
          noteRow("older", "Pricing page lives at /pricing", 600),
          noteRow("a", "Goal: 25 paying customers by December 23", 900),
          noteRow("b", "Reddit outreach: use personal accounts only", 1200),
        ],
      });
    if (path === "/api/memory/conflicts") return json({}, 404);
    return json({}, 404);
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.localStorage.clear();
});

async function openMemoryLinkFromChat(): Promise<string> {
  const api = {
    getWrites: vi.fn(async () => ({
      status: "done",
      items: [
        { note_id: "a", kind: "added", title: "Goal: 25 paying customers by December 23", body_excerpt: "" },
        { note_id: "b", kind: "added", title: "Reddit outreach: use personal accounts only", body_excerpt: "" },
      ],
    })),
    forget: vi.fn(),
    undoForget: vi.fn(),
    undoUpdate: vi.fn(),
    keepConflict: vi.fn(),
    listConflicts: vi.fn(async () => []),
  } as unknown as MemoryApi;
  render(<RememberedPill runId="run-1" api={api} />);
  await flush();
  fireEvent.click(screen.getByRole("button", { name: /Remembered 2 facts/ }));
  const href = screen.getByRole("link", { name: /Open memory/ }).getAttribute("href")!;
  cleanup();
  return href;
}

async function follow(href: string): Promise<string> {
  let current = href;
  for (let hop = 0; hop < 5; hop++) {
    const url = new URL(current, "http://localhost:3000");
    if (url.pathname.startsWith("/workspace")) return `${url.pathname}${url.search}${url.hash}`;
    const res = await middleware(new NextRequest(url.toString()));
    const location = res.headers.get("location");
    if (!location || res.status < 300 || res.status >= 400) return `${url.pathname}${url.search}${url.hash}`;
    const next = new URL(location, url);
    if (next.pathname === "/login") return `${next.pathname}${next.search}`;
    current = `${next.pathname}${next.search}${url.hash}`;
  }
  return current;
}

function resolveTab(location: string): TabDescriptor {
  return resolveWorkspaceTab([], location);
}

async function renderWorkspaceAt(location: string) {
  const tab = resolveTab(location);
  const settled = workspaceTabHref(tab, location);
  window.history.replaceState(null, "", settled);
  ctx.value = {
    tabs: [tab],
    activeTabId: tab.id,
    setActiveTab: vi.fn(),
    treeAgents: [],
    userEmail: "qa@example.com",
    layout: "zavi",
    closeTab: vi.fn(),
    supplyDemandEligible: false,
    supplyDemandReachable: false,
    role: "owner",
  };
  render(<WorkspacePane />);
  await flush();
  return { tab, settled };
}

function expectCurrentMemoryUi() {
  expect(screen.getByRole("heading", { level: 1, name: "Memory" })).toBeTruthy();
  expect(screen.getByRole("searchbox", { name: "Search memory" })).toBeTruthy();
  expect(screen.queryByRole("tablist", { name: "Connectors" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Applications" })).toBeNull();
  expect(screen.queryByRole("link", { name: /Brain/ })).toBeNull();
  expect(apiFetch).toHaveBeenCalledWith("/api/memory/notes");
}

describe("every way into Memory lands on the workspace Memory page", () => {
  it("Open memory under a chat reply stays in the workspace and highlights the facts it named", async () => {
    const href = await openMemoryLinkFromChat();
    const landing = await follow(href);
    expect(new URL(landing, "http://x").pathname).toBe("/workspace");
    const { tab, settled } = await renderWorkspaceAt(landing);
    expect(tab.kind).toBe("memory");
    expect(new URL(settled, "http://x").searchParams.get("h")).toBe("a,b");
    expectCurrentMemoryUi();
    const rows = screen.getAllByTestId("memory-row");
    expect(rows.slice(0, 2).map((r) => r.id)).toEqual(["fact-a", "fact-b"]);
    expect(document.getElementById("fact-a")!.className).toContain("ring-2");
    expect(document.getElementById("fact-older")!.className).not.toContain("ring-2");
  });

  it("coming back to an open Memory tab shows a fact remembered meanwhile and highlights it", async () => {
    const { tab: memory } = await renderWorkspaceAt("/workspace?tab=memory");
    const home = { id: "home-tab", kind: "home", title: "Home", payload: {} } as TabDescriptor;
    const show = (activeTabId: string) => {
      ctx.value = { ...ctx.value, tabs: [memory, home], activeTabId };
    };
    cleanup();
    show(memory.id);
    const view = render(<WorkspacePane home={<div>Home</div>} />);
    await flush();
    show(home.id);
    view.rerender(<WorkspacePane home={<div>Home</div>} />);
    await flush();
    apiFetch.mockImplementation(async (path: string) =>
      path === "/api/memory/notes"
        ? json({ notes: [noteRow("new", "Launch webinar is on October 30", 1), noteRow("older", "Pricing page lives at /pricing", 600)] })
        : json({}, 404),
    );
    window.history.replaceState(null, "", "/workspace?tab=memory&h=new");
    show(memory.id);
    view.rerender(<WorkspacePane home={<div>Home</div>} />);
    await flush();
    expect(screen.getByText("Launch webinar is on October 30")).toBeTruthy();
    expect(document.getElementById("fact-new")!.className).toContain("ring-2");
  });

  it.each([
    ["/memory", null],
    ["/memory/", null],
    ["/memory?h=a,b", "a,b"],
  ])("legacy %s redirects into the workspace before any auth wall", async (legacy, h) => {
    const landing = await follow(legacy);
    const url = new URL(landing, "http://x");
    expect(url.pathname).toBe("/workspace");
    expect(url.searchParams.get("tab")).toBe("memory");
    expect(url.searchParams.get("h")).toBe(h);
    const { tab } = await renderWorkspaceAt(landing);
    expect(tab.kind).toBe("memory");
    expectCurrentMemoryUi();
  });

  it("the /memory page itself redirects to the workspace even if middleware is bypassed", async () => {
    let target = "";
    try {
      await MemoryPage({ searchParams: Promise.resolve({ h: "a,b" }) });
    } catch (e) {
      const digest = String((e as { digest?: string }).digest ?? "");
      target = digest.split(";")[2] ?? "";
    }
    const url = new URL(target, "http://x");
    expect(url.pathname).toBe("/workspace");
    expect(url.searchParams.get("tab")).toBe("memory");
    expect(url.searchParams.get("h")).toBe("a,b");
  });

  it.each(["/workspace#memory", "/workspace#personalization", "/workspace?tab=brain#memory", "/workspace?tab=brain#personalization"])(
    "old hash link %s opens Memory, not Connectors > Integrations",
    async (location) => {
      const { tab, settled } = await renderWorkspaceAt(location);
      expect(tab.kind).toBe("memory");
      expect(settled).toBe("/workspace?tab=memory");
      expectCurrentMemoryUi();
    },
  );

  it("the Brain tab with no memory hash is still Connectors", () => {
    expect(resolveTab("/workspace?tab=brain").kind).toBe("brain");
    expect(resolveTab("/workspace#integrations").kind).toBe("brain");
    expect(resolveTab("/workspace?tab=brain#skills").kind).toBe("brain");
  });

  it("a note editor URL is left alone (no redirect loop into the workspace)", async () => {
    const res = await middleware(new NextRequest("http://localhost:3000/memory/abc"));
    const location = res.headers.get("location") ?? "";
    expect(location).not.toContain("tab=memory");
  });
});
