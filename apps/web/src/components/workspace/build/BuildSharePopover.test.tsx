// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const h = vi.hoisted(() => ({
  role: "owner" as "owner" | "admin" | "member" | "viewer",
  tenantName: "Bikes Co" as string | undefined,
  openTab: vi.fn(),
  members: [] as Array<{ user_id: string; email: string; role: string; joined_at: string | null }>,
  invites: [] as Array<{ id: string; email: string; role: string; invited_at: string | null }>,
  inviteResponse: null as null | (() => Response | Promise<Response>),
  membersResponse: null as null | (() => Response | Promise<Response>),
  writeResponse: null as null | ((path: string, init?: { method?: string }) => Response),
}));

vi.mock("@/components/workspace/WorkspaceShell", () => ({
  useWorkspaceOptional: () => ({
    role: h.role,
    currentUserId: "u-owner",
    tenantName: h.tenantName,
    openTab: h.openTab,
  }),
}));
vi.mock("@/lib/workspace/openBilling", () => ({ openBillingSettings: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));

import { apiFetch } from "@/lib/api";
import { openBillingSettings } from "@/lib/workspace/openBilling";
import { PLANS_HASH } from "@/lib/workspace/pendingPlan";
import { InviteMemberModal } from "@/components/InviteMemberModal";
import { WorkspaceMembersPanel } from "@/components/workspace/WorkspaceMembersPanel";
import { inviteSentMessage, roleChangeOptions } from "@/hooks/useWorkspaceMembers";
import { prefetchWorkspaceMembers, resetWorkspaceMembersCache } from "@/hooks/workspaceMembersCache";
import { isValidInviteEmail } from "@/hooks/useInviteMember";
import {
  BuildShareButton,
  BuildSharePopover,
  GENERAL_ACCESS_COPY,
  INVITE_SCOPE_COPY,
} from "./BuildSharePopover";

const MEMBERS = [
  { user_id: "u-3", email: "vic@example.com", role: "viewer", joined_at: null },
  { user_id: "u-2", email: "ana@example.com", role: "member", joined_at: null },
  { user_id: "u-owner", email: "mohit2703+oct6@yopmail.com", role: "owner", joined_at: null },
  { user_id: "u-4", email: "adi@example.com", role: "admin", joined_at: null },
];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}

function callsTo(path: string, method?: string) {
  return vi
    .mocked(apiFetch)
    .mock.calls.filter(
      ([p, init]) => p === path && (method === undefined || (init as { method?: string } | undefined)?.method === method),
    );
}

function mount() {
  return render(<BuildSharePopover onClose={() => {}} />);
}

function list() {
  return screen.getByRole("list", { name: "People in this workspace" });
}

function typeEmail(value: string) {
  fireEvent.change(screen.getByLabelText("Invite by email"), { target: { value } });
}

function inviteButton() {
  return screen.getByRole("button", { name: "Invite" }) as HTMLButtonElement;
}

beforeEach(() => {
  resetWorkspaceMembersCache();
  h.role = "owner";
  h.tenantName = "Bikes Co";
  h.members = MEMBERS.map((m) => ({ ...m }));
  h.invites = [];
  h.inviteResponse = null;
  h.membersResponse = null;
  h.writeResponse = null;
  vi.mocked(apiFetch).mockReset();
  vi.mocked(openBillingSettings).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (path: string, init?: { method?: string }) => {
    if (path === "/api/v1/members") return h.membersResponse ? h.membersResponse() : json({ members: h.members });
    if (path === "/api/v1/members/invites") return json({ invites: h.invites });
    if (path === "/api/v1/members/invite" && h.inviteResponse) return h.inviteResponse();
    if (h.writeResponse) return h.writeResponse(path, init);
    return json({}, 500);
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Share in Build is the workspace invite", () => {
  it("is titled for the workspace, says invitees join the whole workspace, and has no site link or Publish", async () => {
    mount();
    await flush();
    const dialog = screen.getByRole("dialog", { name: "Invite to Bikes Co" });
    expect(within(dialog).getByText(INVITE_SCOPE_COPY)).toBeTruthy();
    expect(within(dialog).queryByText(/site link|shareable link|preview/i)).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /Copy|Publish|preview/i })).toBeNull();
  });

  it("falls back to 'your workspace' when the workspace has no name", async () => {
    h.tenantName = "  ";
    mount();
    await flush();
    expect(screen.getByRole("dialog", { name: "Invite to your workspace" })).toBeTruthy();
  });

  it("puts email and role in one row, with a full-width Invite under them so the email field keeps its room", async () => {
    mount();
    await flush();
    const field = screen.getByLabelText("Invite by email");
    const row = field.parentElement!;
    expect(within(row).getByLabelText("Role")).toBeTruthy();
    expect(within(row).queryByRole("button", { name: "Invite" })).toBeNull();
    const invite = within(field.closest("form")!).getByRole("button", { name: "Invite" });
    expect(invite.className).toContain("w-full");
    expect(within(screen.getByLabelText("Role")).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Admin",
      "Member",
      "Viewer",
    ]);
  });

  it("lists the owner first, then admins, members, viewers, then pending invites, each with a name and the full email underneath", async () => {
    h.invites = [{ id: "i1", email: "pending@example.com", role: "viewer", invited_at: null }];
    mount();
    await flush();
    const rows = within(list()).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual([
      "Mmohit2703+oct6(You)mohit2703+oct6@yopmail.comowner",
      "Aadiadi@example.comadmin",
      "Aanaana@example.commember",
      "Vvicvic@example.comviewer",
      "PpendingInvitedpending@example.comviewerCancel",
    ]);
    expect(within(rows[0]!).getByText("mohit2703+oct6@yopmail.com").className).not.toContain("truncate");
    const invited = rows[4]!;
    expect(within(invited).getByText("Invited").className).toContain("uppercase");
    expect(within(invited).getByText("pending@example.com").textContent).toBe("pending@example.com");
  });

  it("shows the workspace under General access, honest that access is workspace-wide", async () => {
    mount();
    await flush();
    const label = screen.getByText("General access");
    const row = label.nextElementSibling as HTMLElement;
    expect(within(row).getByText("Bikes Co")).toBeTruthy();
    expect(within(row).getByText(GENERAL_ACCESS_COPY)).toBeTruthy();
  });
});

describe("Invite field", () => {
  it.each([
    ["", false],
    ["ana", false],
    ["ana@", false],
    ["ana@example", false],
    ["ana @example.com", false],
    ["  Ana@Example.com ", true],
  ])("%j enables Invite: %s", async (value, enabled) => {
    mount();
    await flush();
    typeEmail(value);
    expect(inviteButton().disabled).toBe(!enabled);
    expect(isValidInviteEmail(value)).toBe(enabled);
  });

  it("Enter submits; while sending the button spins and the row locks; then it confirms, clears and refreshes the list", async () => {
    const gate = deferred<Response>();
    h.inviteResponse = () => gate.promise;
    mount();
    await flush();
    const membersReadsBefore = callsTo("/api/v1/members").length;
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "admin" } });
    typeEmail("  New@Example.com ");
    fireEvent.submit(screen.getByLabelText("Invite by email").closest("form")!);
    await flush();
    const sending = screen.getByRole("button", { name: "Sending…" }) as HTMLButtonElement;
    expect(sending.disabled).toBe(true);
    expect(sending.querySelector("svg.animate-spin")).toBeTruthy();
    expect((screen.getByLabelText("Invite by email") as HTMLInputElement).disabled).toBe(true);

    fireEvent.submit(screen.getByLabelText("Invite by email").closest("form")!);
    await flush();
    expect(callsTo("/api/v1/members/invite")).toHaveLength(1);

    h.invites = [{ id: "i9", email: "new@example.com", role: "admin", invited_at: null }];
    await act(async () => gate.resolve(json({ ok: true })));
    await flush();
    const [, init] = callsTo("/api/v1/members/invite")[0] as [string, { body: string; idempotent: boolean }];
    expect(JSON.parse(init.body)).toEqual({ email: "new@example.com", role: "admin" });
    expect(init.idempotent).toBe(true);
    expect(screen.getByRole("status").textContent).toBe(inviteSentMessage("new@example.com"));
    expect((screen.getByLabelText("Invite by email") as HTMLInputElement).value).toBe("");
    expect(callsTo("/api/v1/members").length).toBe(membersReadsBefore + 1);
    expect(within(list()).getByText("new@example.com")).toBeTruthy();
    expect(within(list()).getByText("Invited")).toBeTruthy();
    const darkCss = readFileSync(join(__dirname, "..", "..", "..", "app", "workspace-dark.css"), "utf8");
    const escape = (cls: string) => cls.replace(/[:[\]#/]/g, (ch) => `\\${ch}`);
    const hexClasses = new Set(
      Array.from(screen.getByRole("dialog").querySelectorAll<HTMLElement>("[class]"))
        .flatMap((el) => el.getAttribute("class")!.split(/\s+/))
        .filter((cls) => /-\[#[0-9a-fA-F]{3,8}\]/.test(cls)),
    );
    expect(hexClasses.size).toBeGreaterThan(0);
    expect([...hexClasses].filter((cls) => !darkCss.includes(`.${escape(cls)}`))).toEqual([]);
    expect(screen.getByRole("status").className).not.toMatch(/\[#/);
  });

  it("Enter on a malformed address explains it and sends nothing", async () => {
    mount();
    await flush();
    typeEmail("ana@example");
    fireEvent.submit(screen.getByLabelText("Invite by email").closest("form")!);
    await flush();
    expect(screen.getByRole("alert").textContent).toBe("Enter a valid email address.");
    expect(callsTo("/api/v1/members/invite")).toHaveLength(0);
  });

  it("the seat cap swaps Invite for No seats left and See plans, which opens billing on the plans section", async () => {
    const message = "Your Free plan has 1 seat, and it's yours. Upgrade your plan to invite teammates.";
    h.inviteResponse = () => json({ error: { code: "seat_cap_exceeded", message } }, 403);
    const onClose = vi.fn();
    render(<BuildSharePopover onClose={onClose} />);
    await flush();
    typeEmail("teammate@example.com");
    fireEvent.click(inviteButton());
    await flush();
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("No seats left")).toBeTruthy();
    expect(within(alert).getByText(message)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Invite" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "See plans" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(openBillingSettings).toHaveBeenCalledWith(h.openTab, PLANS_HASH);
  });

  it("a slow first list load that lands after the post-invite refresh cannot wipe the new invite", async () => {
    const first = deferred<Response>();
    let reads = 0;
    h.membersResponse = () => {
      reads += 1;
      return reads === 1 ? first.promise : json({ members: h.members });
    };
    h.inviteResponse = () => {
      h.invites = [{ id: "i9", email: "new@example.com", role: "member", invited_at: null }];
      return json({ ok: true });
    };
    mount();
    await flush();
    typeEmail("new@example.com");
    fireEvent.click(inviteButton());
    await flush();
    expect(within(list()).getByText("new@example.com")).toBeTruthy();
    expect(within(list()).getByText("Invited")).toBeTruthy();

    await act(async () => first.resolve(json({ members: h.members })));
    await flush();
    expect(within(list()).getByText("new@example.com")).toBeTruthy();
    expect(within(list()).getByText("Invited")).toBeTruthy();
  });
});

describe("Managing people", () => {
  it("an owner changes a teammate's role from the row; it posts to the role API and refreshes", async () => {
    h.writeResponse = (path) => {
      if (path === "/api/v1/members/u-2/role") {
        h.members = h.members.map((m) => (m.user_id === "u-2" ? { ...m, role: "admin" } : m));
        return json({ ok: true });
      }
      return json({}, 500);
    };
    mount();
    await flush();
    const before = callsTo("/api/v1/members").length;
    fireEvent.click(screen.getByRole("button", { name: "Change role for ana@example.com" }));
    const menu = screen.getByRole("menu", { name: "Role for ana@example.com" });
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Make admin", "Make viewer"]);
    expect(document.activeElement).toBe(within(menu).getAllByRole("menuitem")[0]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Make admin" }));
    await flush();
    const posts = callsTo("/api/v1/members/u-2/role", "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String((posts[0]![1] as { body: string }).body))).toEqual({ role: "admin" });
    expect(callsTo("/api/v1/members").length).toBe(before + 1);
    expect(screen.getByRole("status").textContent).toBe("ana@example.com is now an admin.");
    expect(within(within(list()).getAllByRole("listitem")[2]!).getByText("admin")).toBeTruthy();
  });

  it("the owner's own row, the only owner, never gets a role menu", async () => {
    mount();
    await flush();
    expect(screen.queryByRole("button", { name: "Change role for mohit2703+oct6@yopmail.com" })).toBeNull();
    expect(screen.getAllByRole("button", { name: /^Change role for / })).toHaveLength(3);
    const owner = MEMBERS[2] as { user_id: string; email: string; role: "owner"; joined_at: null };
    expect(roleChangeOptions("owner", owner, "u-owner")).toEqual([]);
    expect(roleChangeOptions("owner", { ...owner, user_id: "u-other" }, "u-owner")).toEqual([]);
    expect(roleChangeOptions("owner", { ...owner, role: "admin" }, "u-owner")).toEqual([]);
  });

  it("an admin can invite and cancel invites but cannot change roles, matching set_member_role's owner-only rule", async () => {
    h.role = "admin";
    h.invites = [{ id: "i1", email: "pending@example.com", role: "member", invited_at: null }];
    mount();
    await flush();
    expect(screen.getByLabelText("Invite by email")).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: /^Change role for / })).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Cancel invite for pending@example.com" })).toBeTruthy();
  });

  it("a click into the preview iframe closes Share, like a click anywhere else outside it", async () => {
    render(<BuildShareButton />);
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await flush();
    expect(screen.getByRole("dialog", { name: "Invite to Bikes Co" })).toBeTruthy();
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    frame.focus();
    expect(document.activeElement).toBe(frame);
    fireEvent.blur(window);
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
    frame.remove();
  });

  it("after a prefetch Share opens with the people already listed, no loading state, then refreshes", async () => {
    await prefetchWorkspaceMembers();
    h.members = [...MEMBERS, { user_id: "u-5", email: "new@example.com", role: "member", joined_at: null }];
    render(<BuildShareButton />);
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(screen.queryByLabelText("Loading people")).toBeNull();
    expect(within(list()).getByText("ana@example.com")).toBeTruthy();
    expect(within(list()).queryByText("new@example.com")).toBeNull();
    await flush();
    expect(within(list()).getByText("new@example.com")).toBeTruthy();
  });

  it("Escape in the role menu closes the menu only; a second Escape closes Share", async () => {
    render(<BuildShareButton />);
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Change role for ana@example.com" }));
    const item = within(screen.getByRole("menu")).getAllByRole("menuitem")[0]!;
    fireEvent.keyDown(item, { key: "Escape" });
    await flush();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Invite to Bikes Co" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("cancelling a pending invite confirms, deletes it through the invites API and refreshes; declining sends nothing", async () => {
    h.invites = [{ id: "i1", email: "pending@example.com", role: "viewer", invited_at: null }];
    h.writeResponse = (path, init) => {
      if (path === "/api/v1/members/invites/i1" && init?.method === "DELETE") {
        h.invites = [];
        return json({ ok: true });
      }
      return json({}, 500);
    };
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    mount();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Cancel invite for pending@example.com" }));
    await flush();
    expect(callsTo("/api/v1/members/invites/i1", "DELETE")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Cancel invite for pending@example.com" }));
    await flush();
    expect(confirmSpy).toHaveBeenLastCalledWith(
      "Cancel the invite to pending@example.com? They won't be able to accept it.",
    );
    expect(callsTo("/api/v1/members/invites/i1", "DELETE")).toHaveLength(1);
    expect(within(list()).queryByText(/pending@example.com/)).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Invite to pending@example.com was cancelled.");
  });

  it.each(["member", "viewer"] as const)("a %s sees everyone read-only: no invite, no role menu, no cancel", async (role) => {
    h.role = role;
    h.invites = [{ id: "i1", email: "pending@example.com", role: "viewer", invited_at: null }];
    mount();
    await flush();
    expect(screen.queryByLabelText("Invite by email")).toBeNull();
    expect(screen.getByText("Only workspace owners and admins can invite people.")).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: /^Change role for |^Cancel invite for / })).toHaveLength(0);
    expect(within(list()).getAllByRole("listitem")).toHaveLength(5);
  });

  it("shows a skeleton while loading, an error with Retry when the list fails, and the list after Retry", async () => {
    const first = deferred<Response>();
    let reads = 0;
    h.membersResponse = () => {
      reads += 1;
      return reads === 1 ? first.promise : json({ members: h.members });
    };
    mount();
    await flush();
    expect(screen.getByRole("status", { name: "Loading people" })).toBeTruthy();
    await act(async () => first.resolve(json({ error: {} }, 500)));
    await flush();
    expect(screen.getByText("Couldn't load team members. Try refreshing.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await flush();
    expect(within(list()).getAllByRole("listitem")).toHaveLength(4);
  });
});

describe("Share and Settings > Team behave the same", () => {
  async function openTeamInvite() {
    render(<WorkspaceMembersPanel role="owner" currentUserId="u-owner" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Invite a member" }));
    await flush();
  }

  const outcomes: Array<[string, () => Response | Promise<Response>]> = [
    ["accepted", () => json({ ok: true })],
    ["already invited (409)", () => json({ error: { code: "conflict", message: "That person is already a member or already has an invite." } }, 409)],
    ["409 without a message", () => json({ error: {} }, 409)],
    ["seat cap", () => json({ error: { code: "seat_cap_exceeded", message: "Your Free plan has 1 seat, and it's yours. Upgrade your plan to invite teammates." } }, 403)],
    ["duplicate check down (503)", () => json({ error: { code: "invite_check_unavailable", message: "Couldn't check your team just now, so no invite was sent. Try again in a minute." } }, 503)],
    ["forbidden", () => json({ error: { code: "forbidden", message: "Only owners and admins can invite teammates." } }, 403)],
    ["network down", () => Promise.reject(new Error("offline"))],
  ];

  it.each(outcomes)("server answers %s: both surfaces send the same request and show the same words", async (_label, answer) => {
    h.inviteResponse = answer;
    mount();
    await flush();
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "viewer" } });
    typeEmail(" Teammate@Example.com ");
    fireEvent.click(inviteButton());
    await flush();
    const share = {
      body: JSON.parse(String((callsTo("/api/v1/members/invite")[0]![1] as { body: string }).body)),
      alerts: screen.queryAllByRole("alert").map((a) => a.textContent),
      status: screen.queryAllByRole("status").map((a) => a.textContent),
    };
    cleanup();
    vi.mocked(apiFetch).mockClear();

    await openTeamInvite();
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: " Teammate@Example.com " } });
    fireEvent.click(screen.getByRole("radio", { name: /Viewer/ }));
    fireEvent.click(screen.getByRole("button", { name: "Send Invite" }));
    await flush();
    const team = {
      body: JSON.parse(String((callsTo("/api/v1/members/invite")[0]![1] as { body: string }).body)),
      alerts: screen.queryAllByRole("alert").map((a) => a.textContent?.replace(/See plans$/, "")),
      status: screen.queryAllByRole("status").map((a) => a.textContent),
    };
    expect(share.body).toEqual({ email: "teammate@example.com", role: "viewer" });
    expect(team.body).toEqual(share.body);
    expect(share.alerts.map((t) => t?.replace(/See plans$/, ""))).toEqual(team.alerts);
    expect(share.status).toEqual(team.status);
  });

  it.each(["ana@example", "ana@", "ana"])("%j is refused the same way by both: the send button stays off", async (value) => {
    mount();
    await flush();
    typeEmail(value);
    expect(inviteButton().disabled).toBe(true);
    cleanup();
    await openTeamInvite();
    fireEvent.change(screen.getByLabelText("Email"), { target: { value } });
    expect((screen.getByRole("button", { name: "Send Invite" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("both list the same people in the same order and change a role through the same request", async () => {
    h.writeResponse = () => json({ ok: true });
    mount();
    await flush();
    const shareOrder = within(list())
      .getAllByRole("listitem")
      .map((r) => MEMBERS.find((m) => r.textContent?.includes(m.email))?.email);
    fireEvent.click(screen.getByRole("button", { name: "Change role for ana@example.com" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Make viewer" }));
    await flush();
    const shareCall = callsTo("/api/v1/members/u-2/role", "POST")[0];
    cleanup();
    vi.mocked(apiFetch).mockClear();

    render(<WorkspaceMembersPanel role="owner" currentUserId="u-owner" />);
    await flush();
    const teamOrder = within(screen.getByTestId("members-table"))
      .getAllByRole("row")
      .slice(1)
      .map((r) => MEMBERS.find((m) => r.textContent?.includes(m.email))?.email);
    expect(teamOrder).toEqual(shareOrder);
    const anaRow = within(screen.getByTestId("members-table"))
      .getAllByRole("row")
      .find((r) => r.textContent?.includes("ana@example.com"))!;
    fireEvent.click(within(anaRow).getByRole("button", { name: "Member actions" }));
    await flush();
    fireEvent.click(screen.getByRole("menuitem", { name: "Make viewer" }));
    await flush();
    expect(callsTo("/api/v1/members/u-2/role", "POST")[0]).toEqual(shareCall);
  });
});

describe("Share on a phone", () => {
  async function phoneRules(className: string): Promise<string> {
    const [{ default: postcss }, { default: tailwindcss }, { default: config }] = await Promise.all([
      import("postcss"),
      import("tailwindcss"),
      import("../../../../tailwind.config"),
    ]);
    const out = await postcss([
      tailwindcss({ ...config, content: [{ raw: `<div class="${className}"></div>`, extension: "html" }], corePlugins: { preflight: false } }),
    ]).process("@tailwind utilities;", { from: undefined });
    const blocks = out.css.split("@media").filter((b) => b.startsWith(" (max-width: 639px)"));
    return blocks.join("\n");
  }

  it("pins the dialog inside a 390px screen, 16px from each edge, instead of hanging off the left", async () => {
    mount();
    await flush();
    const rules = await phoneRules(screen.getByRole("dialog").className);
    expect(rules).toMatch(/position:\s*fixed/);
    expect(rules).toMatch(/left:\s*1rem/);
    expect(rules).toMatch(/right:\s*1rem/);
    expect(rules).toMatch(/width:\s*auto/);
    expect(rules).toMatch(/max-width:\s*none/);
  }, 30_000);

  it("hides the Share label on a phone so the header keeps its room", async () => {
    render(<BuildShareButton />);
    const label = within(screen.getByRole("button", { name: "Share" })).getByText("Share");
    expect(await phoneRules(label.className)).toMatch(/clip:\s*rect\(0,\s*0,\s*0,\s*0\)/);
  }, 30_000);
});

describe("Focus when Share opens", () => {
  function pointer(fine: boolean) {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) => ({ matches: query === "(pointer: fine)" ? fine : false, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList,
    );
  }

  it("puts an owner with a mouse straight into the email field", async () => {
    if (!window.matchMedia) Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: () => ({ matches: false }) });
    pointer(true);
    mount();
    await flush();
    expect(document.activeElement).toBe(screen.getByLabelText("Invite by email"));
  });

  it("on a touch screen focuses the dialog, so the phone keyboard does not pop up", async () => {
    if (!window.matchMedia) Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: () => ({ matches: false }) });
    pointer(false);
    mount();
    await flush();
    expect(document.activeElement).toBe(screen.getByRole("dialog"));
  });

  it("focuses the dialog for someone who cannot invite", async () => {
    if (!window.matchMedia) Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: () => ({ matches: false }) });
    h.role = "viewer";
    pointer(true);
    mount();
    await flush();
    expect(screen.queryByLabelText("Invite by email")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("dialog"));
    h.role = "owner";
  });
});
