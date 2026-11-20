import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
const who = vi.hoisted(() => ({ role: "owner" as string | null }));
vi.mock("../../WorkspaceShell", () => ({
  useWorkspaceOptional: () => ({ role: who.role, tenantId: "t1" }),
}));
vi.mock("../platforms", () => ({ platformFor: () => ({ name: "LinkedIn Ads" }) }));
const db = vi.hoisted(() => ({ answer: { data: { role: "owner" }, error: null } as { data: { role: string } | null; error: { message: string } | null }, reads: 0 }));
vi.mock("@/lib/supabase", () => ({
  createBrowserSupabase: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } }, error: null }) },
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => {
          db.reads += 1;
          return db.answer;
        },
      };
      return q;
    },
  }),
}));

import { BoundAdsCampaigns } from "./BoundAdsCampaigns";

const RAW = "This action requires one of: owner, admin. Your role: member.";
const A = "10000000-0000-4000-8000-00000000000a";
const B = "10000000-0000-4000-8000-00000000000b";
const ROWS = [
  { id: A, provider_campaign_id: "111", funding_source: "provider", name: "Alpha", status: "PAUSED" },
  { id: B, provider_campaign_id: "222", funding_source: "provider", name: "Bravo", status: "ACTIVE" },
];
const reply = (status: number, body: unknown) => Promise.resolve({ ok: status < 400, status, json: async () => body });
let pauseReply: () => Promise<unknown>;

const posts = () => apiFetch.mock.calls.filter(([, o]) => (o as RequestInit | undefined)?.method === "POST").map(([p]) => String(p));
const rowOf = (name: string) => screen.getByText(name).closest("li") as HTMLElement;
const OWNERS_ONLY = "Only workspace owners and admins can launch or pause campaigns.";

beforeEach(() => {
  apiFetch.mockReset();
  who.role = "owner";
  db.reads = 0;
  db.answer = { data: { role: "owner" }, error: null };
  pauseReply = () => reply(200, { status: "paused" });
  apiFetch.mockImplementation((path: string, opts?: RequestInit) => {
    if (path.includes("?platform=")) return reply(200, { campaigns: ROWS });
    if (/\/pause$/.test(path) && opts?.method === "POST") return pauseReply();
    return reply(200, {});
  });
});
afterEach(() => cleanup());

describe("LinkedIn Ads launch controls when the founder's role cannot be read", () => {
  it("never claims the founder is not an owner, shows a retry note, and brings the controls back once the role reads", async () => {
    who.role = null;
    db.answer = { data: null, error: { message: "timeout" } };
    render(<BoundAdsCampaigns platform="linkedin" />);
    await waitFor(() => expect(screen.getByTestId("role-unread").textContent).toContain("could not check your workspace role"));
    expect(document.body.textContent).not.toContain(OWNERS_ONLY);
    expect(screen.queryByRole("button", { name: "Review launch" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    db.answer = { data: { role: "owner" }, error: null };
    fireEvent.click(within(screen.getByTestId("role-unread")).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(within(rowOf("Alpha")).getByRole("button", { name: "Review launch" })).toBeTruthy());
    expect(within(rowOf("Bravo")).getByRole("button", { name: "Pause" })).toBeTruthy();
    expect(screen.queryByTestId("role-unread")).toBeNull();
  });

  it("a member whose role really is member still reads the owners-and-admins note", async () => {
    who.role = null;
    db.answer = { data: { role: "member" }, error: null };
    render(<BoundAdsCampaigns platform="linkedin" />);
    await waitFor(() => expect(screen.getByText(OWNERS_ONLY)).toBeTruthy());
    expect(screen.queryByTestId("role-unread")).toBeNull();
  });
});

describe("a founder whose role was lowered while the page was open", () => {
  it("loses Launch and Pause when the page regains focus", async () => {
    render(<BoundAdsCampaigns platform="linkedin" />);
    await waitFor(() => expect(within(rowOf("Alpha")).getByRole("button", { name: "Review launch" })).toBeTruthy());
    expect(db.reads).toBe(0);
    db.answer = { data: { role: "member" }, error: null };
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(screen.getByText(OWNERS_ONLY)).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Review launch" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
  });

  it("a refused Pause reads in plain words, never the server text, and the role is read again", async () => {
    pauseReply = () => reply(403, { error: { code: "forbidden", message: RAW } });
    render(<BoundAdsCampaigns platform="linkedin" />);
    await waitFor(() => expect(within(rowOf("Bravo")).getByRole("button", { name: "Pause" })).toBeTruthy());
    db.answer = { data: { role: "member" }, error: null };
    await act(async () => {
      fireEvent.click(within(rowOf("Bravo")).getByRole("button", { name: "Pause" }));
    });
    await waitFor(() => expect(screen.getByText(OWNERS_ONLY)).toBeTruthy());
    expect(posts()).toEqual([`/api/ads/campaigns/${B}/pause`]);
    expect(document.body.textContent).toContain("Only a workspace owner or admin can do this.");
    expect(document.body.textContent).not.toContain("requires one of");
    expect(document.body.textContent).not.toContain("Your role:");
    expect(db.reads).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
  });
});
