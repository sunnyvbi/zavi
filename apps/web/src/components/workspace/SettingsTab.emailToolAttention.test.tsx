// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, within } from "@testing-library/react";

const h = vi.hoisted(() => ({
  routes: [] as Array<{ route: string; label: string; status: string; error: string | null; lists: unknown[] }>,
  gmail: undefined as { status: string } | undefined,
  extraMeta: [] as Array<{ slug: string }>,
  hang: false,
  listsFail: false,
  keyResult: null as unknown,
  listsGate: null as Promise<void> | null,
  startComposioConnect: vi.fn(async (_toolkit: string) => {}),
  calls: [] as Array<{ path: string; method: string }>,
  removed: new Set<string>(),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("tab=brain"),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/workspace",
}));
vi.mock("@/lib/api", () => ({
  apiFetch: (path: string, init?: { method?: string }) => {
    h.calls.push({ path, method: init?.method ?? "GET" });
    if (path === "/api/connectors/composio/klaviyo/disconnect") h.removed.add("composio.klaviyo");
    if (h.listsFail && path === "/api/workspace/email-test-lists") return Promise.resolve({ ok: false, status: 500, json: async () => ({ error: { message: "down" } }) });
    return h.hang ? new Promise(() => {}) : (path === "/api/workspace/email-test-lists" && h.listsGate ? h.listsGate : Promise.resolve()).then(() => ({
      ok: true,
      status: 200,
      json: async () => (path === "/api/workspace/email-test-lists" ? { routes: h.routes, orphans: [], gmail: h.gmail } : path === "/api/connectors/email" && h.keyResult ? h.keyResult : {}),
    }));
  },
}));
vi.mock("@/lib/active-tenant-client", () => ({ getActiveTenantId: async () => "tenant-1" }));
const META = [
  { slug: "email", team_id: null, team_name: null, account_login: null, repo_full_names: null, repo_ids: null, selected_repo_ids: null, default_repo_full_name: null, connected_at: "2026-10-01T00:00:00Z", token_expires_at: null, scopes: [] },
  { slug: "composio.klaviyo" },
  { slug: "composio.mailchimp" },
];
vi.mock("@/lib/supabase", () => {
  const chain = (table: string): Record<string, unknown> => {
    const result = { data: table === "connector_metadata" ? [...META, ...h.extraMeta].filter((r) => !h.removed.has(r.slug)) : [], error: null };
    const q: Record<string, unknown> = {
      select: () => q,
      eq: () => q,
      in: () => q,
      order: () => q,
      limit: () => q,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(result).then(ok, bad),
    };
    return q;
  };
  return {
    createBrowserSupabase: () => ({
      from: (table: string) => chain(table),
      auth: { getSession: async () => ({ data: { session: null } }) },
    }),
  };
});
vi.mock("@/app/connectors/composioConnect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/connectors/composioConnect")>()),
  startComposioConnect: (toolkit: string) => h.startComposioConnect(toolkit),
}));
vi.mock("./WorkspaceShell", () => ({
  useWorkspace: () => ({ role: "owner", currentUserId: "user-1", openTab: vi.fn(), tenantName: "Pixel Drift" }),
  useWorkspaceOptional: () => ({ role: "owner", currentUserId: "user-1" }),
}));
vi.mock("./layout/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./layout/shared")>()),
  useOpenStatic: () => vi.fn(),
}));
vi.mock("./settings/useConnectorRecommendations", () => ({ useConnectorRecommendations: () => [] }));
vi.mock("./settings/useSlackScopeStatus", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settings/useSlackScopeStatus")>()),
  useSlackScopeStatus: () => [],
}));
vi.mock("./settings/useConnectorSyncStatus", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settings/useConnectorSyncStatus")>()),
  useConnectorSyncStatus: () => ({}),
}));

import { SettingsTab } from "./SettingsTab";
import { ConfirmDialogHost } from "@/components/ui/ConfirmDialog";
import { forgetEmailTestLists } from "@/lib/workspace/emailCampaignSettingsApi";
import { useEmailToolIssues } from "./settings/useEmailToolIssues";
import { ConnectedAppTiles } from "./settings/ConnectedApps";

const route = (r: string, label: string, status: string, error: string | null = null) => ({ route: r, label, status, error, lists: [] });

beforeEach(() => {
  forgetEmailTestLists();
  h.gmail = undefined;
  h.extraMeta = [];
  h.hang = false;
  h.listsFail = false;
  h.keyResult = null;
  h.listsGate = null;
  h.startComposioConnect.mockClear();
  h.calls = [];
  h.removed.clear();
});
afterEach(cleanup);

async function openConnectors() {
  const view = render(<SettingsTab only="integration" />);
  for (let i = 0; i < 6; i++) await act(async () => {});
  const heading = screen.getByRole("heading", { name: "Needs attention" });
  return { view, strip: heading.parentElement as HTMLElement };
}

describe("Connectors page shows what the email channel already knows", () => {
  it("SendGrid with a rejected key, Klaviyo unreachable and Mailchimp rejected all move to Needs attention", async () => {
    h.routes = [
      route("sendgrid", "SendGrid", "unreadable", "SendGrid rejected the key Zavi has saved."),
      route("klaviyo", "Klaviyo", "unreadable", "Klaviyo did not answer."),
      route("mailchimp", "Mailchimp", "unreadable", "Mailchimp rejected the key Zavi has saved."),
      route("zavi_list", "Zavi", "complete"),
    ];
    const { strip } = await openConnectors();

    expect(within(strip).queryByText(/Every connection is working/)).toBeNull();
    const sendgrid = strip.querySelector("#connector-email") as HTMLElement;
    expect(sendgrid).not.toBeNull();
    expect(within(sendgrid).getByText("Key rejected")).toBeTruthy();
    expect(within(sendgrid).getByText(/SendGrid rejected the key Zavi has saved/)).toBeTruthy();
    expect(within(sendgrid).queryByText("Ready for email campaigns")).toBeNull();

    const klaviyo = strip.querySelector("#connector-klaviyo") as HTMLElement;
    expect(within(klaviyo).getByText("Can't reach")).toBeTruthy();
    const mailchimp = strip.querySelector("#connector-mailchimp") as HTMLElement;
    expect(within(mailchimp).getByText("Key rejected")).toBeTruthy();

    expect(document.querySelectorAll("#connector-email")).toHaveLength(1);
    expect(screen.queryByText("Ready for email campaigns")).toBeNull();
    expect(screen.getAllByText("Klaviyo").filter((el) => !strip.contains(el))).toHaveLength(0);

    expect(strip.querySelector('input[placeholder="SG.…"]')).toBeNull();
    fireEvent.click(within(sendgrid).getByRole("button", { name: "Reconnect" }));
    expect(strip.querySelector('input[placeholder="SG.…"]')).not.toBeNull();

    fireEvent.click(within(klaviyo).getByRole("button", { name: "Reconnect" }));
    expect(h.startComposioConnect).toHaveBeenCalledWith("klaviyo");
  });

  it("when the email tools' health read fails the strip does not claim every connection works, and Try again re-reads it", async () => {
    h.listsFail = true;
    h.routes = [route("sendgrid", "SendGrid", "unreadable", "SendGrid rejected the key Zavi has saved."), route("klaviyo", "Klaviyo", "complete")];
    const { strip } = await openConnectors();
    expect(within(strip).queryByText(/Every connection is working/)).toBeNull();
    expect(within(strip).getByText(/could not check your email tools/)).toBeTruthy();
    const reads = () => h.calls.filter((c) => c.path === "/api/workspace/email-test-lists").length;
    const before = reads();
    h.listsFail = false;
    fireEvent.click(within(strip).getByRole("button", { name: "Try again" }));
    for (let i = 0; i < 6; i++) await act(async () => {});
    expect(reads()).toBeGreaterThan(before);
    expect(within(strip).queryByText(/could not check your email tools/)).toBeNull();
    expect(strip.querySelector("#connector-email")).not.toBeNull();
  });

  it("the Reconnect form in Needs attention stays open on the permission result after the key saves, and re-reads only when Done is pressed", async () => {
    h.routes = [route("sendgrid", "SendGrid", "unreadable", "SendGrid rejected the key Zavi has saved.")];
    h.keyResult = { campaign_ready: false, permissions: [{ group: "mail", label: "Mail Send", passed: true }, { group: "marketing", label: "Marketing", passed: false }] };
    const { strip } = await openConnectors();
    fireEvent.click(within(strip.querySelector("#connector-email") as HTMLElement).getByRole("button", { name: "Reconnect" }));
    fireEvent.change(strip.querySelector('input[placeholder="SG.…"]') as HTMLInputElement, { target: { value: "SG." + "a".repeat(30) } });
    const reads = () => h.calls.filter((c) => c.path === "/api/workspace/email-test-lists").length;
    const before = reads();
    h.routes = [route("sendgrid", "SendGrid", "complete")];
    fireEvent.click(within(strip).getByRole("button", { name: "Connect" }));
    for (let i = 0; i < 6; i++) await act(async () => {});
    expect(within(strip).getByText("Needs more permissions for campaigns")).toBeTruthy();
    expect(within(strip).getByLabelText("SendGrid permissions").textContent).toContain("Marketing");
    expect(reads()).toBe(before);
    fireEvent.click(within(strip).getByRole("button", { name: "Done" }));
    for (let i = 0; i < 6; i++) await act(async () => {});
    expect(reads()).toBeGreaterThan(before);
    expect(screen.queryByLabelText("SendGrid permissions")).toBeNull();
  });

  it("healthy email tools stay in Connected and the strip says every connection works", async () => {
    h.routes = [
      route("sendgrid", "SendGrid", "complete"),
      route("klaviyo", "Klaviyo", "complete"),
      route("mailchimp", "Mailchimp", "partial"),
    ];
    const { strip } = await openConnectors();

    expect(within(strip).getByText(/Every connection is working/)).toBeTruthy();
    expect(strip.querySelector("#connector-email")).toBeNull();
    expect(strip.querySelector("#connector-klaviyo")).toBeNull();
    expect(screen.getAllByText("Klaviyo").length).toBeGreaterThan(0);
  });

  it("a connected Gmail the email channel can't read stays in Connected, out of Needs attention", async () => {
    h.extraMeta = [{ slug: "composio.gmail" }];
    h.gmail = { status: "unreadable" };
    h.routes = [route("sendgrid", "SendGrid", "complete"), route("klaviyo", "Klaviyo", "complete")];
    const { strip } = await openConnectors();

    expect(within(strip).getByText(/Every connection is working/)).toBeTruthy();
    expect(within(strip).queryByText("Gmail")).toBeNull();
    expect(strip.querySelector("#connector-gmail")).toBeNull();
    const connected = screen.getByRole("heading", { name: "Connected" }).parentElement as HTMLElement;
    expect(within(connected).getAllByText("Gmail").length).toBeGreaterThan(0);
  });

  it("a reload clears the old badge while the new read is still in flight", async () => {
    h.routes = [route("klaviyo", "Klaviyo", "unreadable", "Klaviyo rejected the key Zavi has saved.")];
    const hook = renderHook(({ k }) => useEmailToolIssues(true, k), { initialProps: { k: 0 } });
    for (let i = 0; i < 4; i++) await act(async () => {});
    expect(hook.result.current.issues.get("klaviyo")).toBe("rejected");
    expect(hook.result.current.checking).toBe(false);

    h.hang = true;
    hook.rerender({ k: 1 });
    for (let i = 0; i < 4; i++) await act(async () => {});
    expect(hook.result.current.issues.size).toBe(0);
    expect(hook.result.current.checking).toBe(true);
  });

  it("while the email tools' health is still loading, the page does not claim SendGrid or Klaviyo are fine, then shows them broken", async () => {
    let open = () => {};
    h.listsGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    h.routes = [
      route("sendgrid", "SendGrid", "unreadable", "SendGrid rejected the key Zavi has saved."),
      route("klaviyo", "Klaviyo", "unreadable", "Klaviyo did not answer."),
      route("mailchimp", "Mailchimp", "complete"),
    ];
    const { strip } = await openConnectors();

    expect(screen.queryByText(/Every connection is working/)).toBeNull();
    expect(within(strip).getByText("Checking your connections…")).toBeTruthy();
    expect(screen.queryByText("Ready for email campaigns")).toBeNull();
    expect(document.querySelector("#connector-email")).toBeNull();
    expect(document.querySelector("#connector-klaviyo")).toBeNull();
    expect(screen.queryAllByText("SendGrid")).toHaveLength(0);
    expect(screen.queryAllByText("Klaviyo")).toHaveLength(0);
    expect(screen.queryAllByText("Mailchimp")).toHaveLength(0);

    await act(async () => open());
    for (let i = 0; i < 6; i++) await act(async () => {});

    expect(screen.queryByText("Checking your connections…")).toBeNull();
    expect(screen.queryByText(/Every connection is working/)).toBeNull();
    const sendgrid = strip.querySelector("#connector-email") as HTMLElement;
    expect(within(sendgrid).getByText("Key rejected")).toBeTruthy();
    expect(within(sendgrid).getByRole("button", { name: "Reconnect" })).toBeTruthy();
    const klaviyo = strip.querySelector("#connector-klaviyo") as HTMLElement;
    expect(within(klaviyo).getByText("Can't reach")).toBeTruthy();
    expect(document.querySelectorAll("#connector-email")).toHaveLength(1);
    expect(document.querySelectorAll("#connector-klaviyo")).toHaveLength(1);
    expect(screen.queryByText("Ready for email campaigns")).toBeNull();
    const connected = screen.getByRole("heading", { name: "Connected" }).parentElement as HTMLElement;
    expect(within(connected).getAllByText("Mailchimp").length).toBeGreaterThan(0);
    expect(within(connected).queryByText("Klaviyo")).toBeNull();
    expect(within(connected).queryByText("SendGrid")).toBeNull();
  });
});

describe("a broken email tool in Needs attention can be disconnected", () => {
  const writes = () => h.calls.filter((c) => c.method !== "GET");

  async function brokenStrip() {
    h.routes = [
      route("sendgrid", "SendGrid", "unreadable", "SendGrid rejected the key Zavi has saved."),
      route("klaviyo", "Klaviyo", "unreadable", "Klaviyo did not answer."),
      route("mailchimp", "Mailchimp", "complete"),
    ];
    render(<ConfirmDialogHost />);
    const { strip } = await openConnectors();
    return {
      strip,
      sendgrid: strip.querySelector("#connector-email") as HTMLElement,
      klaviyo: strip.querySelector("#connector-klaviyo") as HTMLElement,
    };
  }

  async function pickDisconnect(tile: HTMLElement) {
    fireEvent.click(within(tile).getByRole("button", { name: "More options" }));
    fireEvent.click(within(tile).getByRole("menuitem", { name: "Disconnect" }));
    for (let i = 0; i < 4; i++) await act(async () => {});
  }

  it("SendGrid with a rejected key: Disconnect asks with the healthy-tile copy and sends DELETE /api/connectors/email only", async () => {
    const { sendgrid, klaviyo } = await brokenStrip();
    expect(within(sendgrid).getByText("Key rejected")).toBeTruthy();
    expect(within(klaviyo).getByText("Can't reach")).toBeTruthy();

    await pickDisconnect(sendgrid);
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText("Disconnect SendGrid?")).toBeTruthy();
    expect(writes()).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    for (let i = 0; i < 4; i++) await act(async () => {});

    expect(writes()).toEqual([{ path: "/api/connectors/email", method: "DELETE" }]);
  });

  it("cancelling the SendGrid confirm sends nothing", async () => {
    const { sendgrid } = await brokenStrip();
    await pickDisconnect(sendgrid);
    const dialog = screen.getByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    for (let i = 0; i < 4; i++) await act(async () => {});
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(writes()).toEqual([]);
  });

  it("Klaviyo unreachable: Disconnect confirms like the Connected tile, POSTs the composio disconnect for Klaviyo only, and the tile leaves", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    try {
      const { klaviyo } = await brokenStrip();
      await pickDisconnect(klaviyo);
      expect(confirmSpy).toHaveBeenCalledTimes(1);
      expect(confirmSpy).toHaveBeenCalledWith("Disconnect Klaviyo?");
      expect(writes()).toEqual([{ path: "/api/connectors/composio/klaviyo/disconnect", method: "POST" }]);
      expect(screen.queryByRole("alertdialog")).toBeNull();
      for (let i = 0; i < 6; i++) await act(async () => {});
      expect(document.querySelector("#connector-klaviyo")).toBeNull();
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it("cancelling the Klaviyo confirm sends nothing and keeps the tile", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    try {
      const { klaviyo } = await brokenStrip();
      await pickDisconnect(klaviyo);
      expect(confirmSpy).toHaveBeenCalledWith("Disconnect Klaviyo?");
      expect(writes()).toEqual([]);
      expect(document.querySelector("#connector-klaviyo")).not.toBeNull();
    } finally {
      confirmSpy.mockRestore();
    }
  });
});

describe("a Connected aggregator tile is busy only after the disconnect is confirmed", () => {
  const notion = { rail: "composio" as const, app: "notion", slug: "composio.notion", name: "Notion", logo: null };

  function pickDisconnect() {
    render(<ConnectedAppTiles apps={[notion]} readOnly={false} onRemoved={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Manage/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Disconnect" }));
    return screen.getByRole("button", { name: /Manage/ }) as HTMLButtonElement;
  }

  it("cancelling the confirm never marks the tile busy and sends nothing", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    try {
      const manage = pickDisconnect();
      expect(confirmSpy).toHaveBeenCalledWith("Disconnect Notion?");
      expect(manage.disabled).toBe(false);
      for (let i = 0; i < 4; i++) await act(async () => {});
      expect(manage.disabled).toBe(false);
      expect(h.calls).toEqual([]);
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it("confirming marks the tile busy while the disconnect is in flight", async () => {
    h.hang = true;
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    try {
      const manage = pickDisconnect();
      for (let i = 0; i < 4; i++) await act(async () => {});
      expect(h.calls).toEqual([{ path: "/api/connectors/composio/notion/disconnect", method: "POST" }]);
      expect(manage.disabled).toBe(true);
    } finally {
      confirmSpy.mockRestore();
    }
  });
});
