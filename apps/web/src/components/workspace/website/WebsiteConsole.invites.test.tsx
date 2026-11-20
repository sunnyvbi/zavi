// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent, within } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

let mockRole: "owner" | "admin" | "member" | null = "owner";
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ role: mockRole, openTab: vi.fn() }),
}));

import { UsersView, WebsiteConsole, __resetAppCatalogInflight } from "./WebsiteConsole";

type Col = { name: string; type: string; writable?: boolean; primary_key?: boolean; enum_values?: string[] | null };

const ROLE_COLS: Col[] = [
  { name: "id", type: "uuid", primary_key: true, writable: false },
  { name: "email", type: "text", writable: true },
  { name: "role", type: "app_role", writable: true, enum_values: ["user", "admin"] },
];
const NO_ROLE_COLS: Col[] = ROLE_COLS.filter((c) => c.name !== "role");

const ONE_USER = [{ id: "u1", email: "alice@example.com", role: "user" }];

type Invite = { id: string; role: "user" | "admin"; created_at: string; expires_at: string };

function jsonRes(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

function wire({
  columns = ROLE_COLS,
  rows = ONE_USER,
  invites = [] as Invite[],
  invitesStatus = 200,
  invitesBody,
  create = {
    status: 201,
    body: {
      invite_url: "https://site.example.com/signup?invite=tok_abc",
      expires_at: "2026-10-04T12:00:00.000Z",
      role: "admin",
    },
  },
  revoke = { status: 200, body: { ok: true } },
}: {
  columns?: Col[];
  rows?: Record<string, unknown>[];
  invites?: Invite[];
  invitesStatus?: number;
  invitesBody?: unknown;
  create?: { status: number; body: unknown };
  revoke?: { status: number; body: unknown };
} = {}) {
  let pending = [...invites];
  apiFetch.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    if (url.includes("/app-catalog")) {
      return Promise.resolve(
        jsonRes({ connected: true, tables: [{ name: "users", row_estimate: null, columns }] }),
      );
    }
    if (url.includes("/app-rows")) {
      return Promise.resolve(
        jsonRes({
          connected: true,
          supported: true,
          table: "users",
          columns,
          rows,
          row_keys: rows.map((r) => ({ id: r.id })),
          row_versions: rows.map((_, i) => String(i + 1)),
          has_more: false,
          masked_columns: [],
          writable: true,
        }),
      );
    }
    if (url.endsWith("/revoke") && method === "POST") {
      const id = decodeURIComponent(url.split("/").slice(-2)[0]);
      if (revoke.status < 400) pending = pending.filter((i) => i.id !== id);
      return Promise.resolve(jsonRes(revoke.body, revoke.status));
    }
    if (url.includes("/app-invites") && method === "POST") {
      return Promise.resolve(jsonRes(create.body, create.status));
    }
    if (url.includes("/app-invites")) {
      return Promise.resolve(
        jsonRes(invitesBody ?? { connected: true, invites: pending }, invitesStatus),
      );
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
}

const invitesGets = () =>
  apiFetch.mock.calls.filter(
    (c) => String(c[0]).includes("/app-invites") && !(c[1] as { method?: string } | undefined)?.method,
  );
const invitePosts = () =>
  apiFetch.mock.calls.filter(
    (c) => String(c[0]) === "/api/website/app-invites" && (c[1] as { method?: string })?.method === "POST",
  );

beforeEach(() => {
  apiFetch.mockReset();
  mockRole = "owner";
  __resetAppCatalogInflight();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function openInviteDialog() {
  fireEvent.click(await screen.findByRole("button", { name: /Invite User/ }));
  return screen.getByRole("dialog", { name: "Invite to your site" });
}

describe("UsersView invite links", () => {
  it("creates an admin link and shows the URL, the expiry and the password warning", async () => {
    wire();
    render(<UsersView deployedUrl="https://site.example.com" />);
    await screen.findByText("alice@example.com");
    const dialog = await openInviteDialog();

    expect(within(dialog).getByRole("radio", { name: "User" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(dialog).getByRole("radio", { name: "Admin" }));
    fireEvent.click(within(dialog).getByRole("button", { name: /create a link to share/i }));

    const field = (await within(dialog).findByLabelText("Invite link")) as HTMLInputElement;
    expect(field.value).toBe("https://site.example.com/signup?invite=tok_abc");
    expect(field.readOnly).toBe(true);
    expect(within(dialog).getByText(/^Expires Oct \d, 2026\./)).toBeTruthy();
    expect(
      within(dialog).getByText(
        "Anyone with this link can become an admin of your site. Treat it like a password.",
      ),
    ).toBeTruthy();
    expect(invitePosts()).toHaveLength(1);
    expect(JSON.parse((invitePosts()[0][1] as { body: string }).body)).toEqual({ role: "admin" });
    await waitFor(() => expect(invitesGets().length).toBeGreaterThanOrEqual(2));
  });

  it("shows the account-creation line (not the admin warning) for a user link", async () => {
    wire({
      create: {
        status: 201,
        body: { invite_url: "https://site.example.com/signup?invite=u", expires_at: "2026-10-04T12:00:00.000Z", role: "user" },
      },
    });
    render(<UsersView deployedUrl="https://site.example.com" />);
    await screen.findByText("alice@example.com");
    const dialog = await openInviteDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: /create a link to share/i }));
    expect(await within(dialog).findByText("Anyone with this link can create an account.")).toBeTruthy();
    expect(within(dialog).queryByText(/Treat it like a password/)).toBeNull();
  });

  it("discards the link when the dialog is closed", async () => {
    wire();
    render(<UsersView deployedUrl="https://site.example.com" />);
    await screen.findByText("alice@example.com");
    let dialog = await openInviteDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: /create a link to share/i }));
    await within(dialog).findByLabelText("Invite link");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close invite dialog" }));
    dialog = await openInviteDialog();
    expect(within(dialog).queryByLabelText("Invite link")).toBeNull();
  });

  it.each([
    [400, "invalid_body", "Pick User or Admin, then try again."],
    [403, "forbidden", "Only workspace owners and admins can create invite links."],
    [409, "roles_not_configured", "Roles aren't set up on this site yet."],
    [409, "site_not_deployed", "Publish the site before creating invite links."],
    [409, "site_has_no_signup", "Your site has no sign-up page yet, so an invite link would open a 404. Ask Zavi to add sign-in to your site first."],
    [503, "app_db_not_ready", "Your site's database is still being set up. Try again in a few minutes."],
    [500, "unavailable", "We couldn't create an invite link right now. Try again shortly."],
  ])("maps a %s %s to its own copy", async (status, code, copy) => {
    wire({ create: { status, body: { error: { code, message: "server text" } } } });
    render(<UsersView deployedUrl="https://site.example.com" />);
    await screen.findByText("alice@example.com");
    const dialog = await openInviteDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: /create a link to share/i }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(copy);
    expect(within(dialog).queryByLabelText("Invite link")).toBeNull();
  });

  it("lists pending invites and revoke removes the row after a confirm", async () => {
    wire({
      invites: [
        { id: "7", role: "admin", created_at: "2026-09-27T10:00:00.000Z", expires_at: "2026-10-04T10:00:00.000Z" },
      ],
    });
    render(<UsersView deployedUrl="https://site.example.com" />);
    expect(await screen.findByText("Pending invites")).toBeTruthy();
    expect(screen.getAllByTestId("pending-invite")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Revoke Admin invite" }));
    const confirm = screen.getByRole("alertdialog");
    fireEvent.click(within(confirm).getByRole("button", { name: "Revoke link" }));

    await waitFor(() => expect(screen.queryByTestId("pending-invite")).toBeNull());
    expect(screen.queryByText("Pending invites")).toBeNull();
    const revokeCall = apiFetch.mock.calls.find((c) => String(c[0]).endsWith("/revoke"));
    expect(revokeCall?.[0]).toBe("/api/website/app-invites/7/revoke");
  });

  it("hides the pending list when there are no invites", async () => {
    wire();
    render(<UsersView deployedUrl="https://site.example.com" />);
    await screen.findByText("alice@example.com");
    await waitFor(() => expect(invitesGets()).toHaveLength(1));
    expect(screen.queryByText("Pending invites")).toBeNull();
  });

  it("zero users: 'Invite yourself as admin' opens the dialog preset to Admin, with Refresh beside it", async () => {
    wire({ rows: [] });
    render(<UsersView deployedUrl="https://site.example.com" />);
    fireEvent.click(await screen.findByRole("button", { name: /Invite yourself as admin/ }));
    const dialog = screen.getByRole("dialog", { name: "Invite to your site" });
    expect(within(dialog).getByRole("radio", { name: "Admin" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close invite dialog" }));

    const before = apiFetch.mock.calls.filter((c) => String(c[0]).includes("/app-rows")).length;
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    await waitFor(() =>
      expect(apiFetch.mock.calls.filter((c) => String(c[0]).includes("/app-rows")).length).toBe(before + 1),
    );
  });

  it("users but no admin: a note says the admin pages are locked and offers an admin invite", async () => {
    wire();
    render(<UsersView deployedUrl="https://site.example.com" />);
    const note = await screen.findByTestId("users-no-admin-note");
    expect(note.textContent).toContain("No one is an admin yet");
    fireEvent.click(within(note).getByRole("button", { name: /Get admin link/ }));
    const dialog = screen.getByRole("dialog", { name: "Invite to your site" });
    expect(within(dialog).getByRole("radio", { name: "Admin" }).getAttribute("aria-checked")).toBe("true");
  });

  it("no no-admin note once someone is an admin", async () => {
    wire({ rows: [...ONE_USER, { id: "u2", email: "owner@example.com", role: "admin" }] });
    render(<UsersView deployedUrl="https://site.example.com" />);
    await screen.findByText("owner@example.com");
    expect(screen.queryByTestId("users-no-admin-note")).toBeNull();
  });

  it("a users table without a role column says roles aren't set up and offers no invite", async () => {
    wire({ columns: NO_ROLE_COLS, rows: [] });
    render(<UsersView deployedUrl="https://site.example.com" />);
    expect(await screen.findByText("Roles aren’t set up on this site yet.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Invite User/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Invite yourself as admin/ })).toBeNull();
    expect(invitesGets()).toHaveLength(0);
  });

  it("a site whose invites route says roles_not_configured offers no invite", async () => {
    wire({ invitesStatus: 409, invitesBody: { error: { code: "roles_not_configured", message: "x" } } });
    render(<UsersView deployedUrl="https://site.example.com" />);
    expect(await screen.findByText("Roles aren’t set up on this site yet.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Invite User/ })).toBeNull();
  });

  it("a site with no sign-up page explains why and offers no invite, even with zero users", async () => {
    wire({ rows: [], invitesBody: { connected: true, invites: [], signup_available: false } });
    render(<UsersView deployedUrl="https://site.example.com" />);
    expect(await screen.findByText("Your site has no sign-up page yet, so an invite link would open a 404. Ask Zavi to add sign-in to your site first.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Invite yourself as admin/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Invite User/ })).toBeNull();
    expect(screen.queryByText(/No users yet/)).toBeNull();
  });

  it("an unknown sign-up check still offers invites", async () => {
    wire({ rows: [], invitesBody: { connected: true, invites: [], signup_available: null } });
    render(<UsersView deployedUrl="https://site.example.com" />);
    expect(await screen.findByRole("button", { name: /Invite yourself as admin/ })).toBeTruthy();
  });

  it("a member sees neither create nor revoke, and no invites request fires", async () => {
    mockRole = "member";
    wire({
      invites: [
        { id: "7", role: "admin", created_at: "2026-09-27T10:00:00.000Z", expires_at: "2026-10-04T10:00:00.000Z" },
      ],
    });
    render(<UsersView deployedUrl="https://site.example.com" />);
    await screen.findByText(/visible to owners and admins/i);
    expect(screen.queryByRole("button", { name: /Invite User/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Revoke/ })).toBeNull();
    expect(screen.queryByText("Pending invites")).toBeNull();
    expect(invitesGets()).toHaveLength(0);
  });

  it("the catalog's not_ready reason reads as 'still being set up'", async () => {
    apiFetch.mockImplementation((url: string) => {
      if (url.includes("/app-catalog")) return Promise.resolve(jsonRes({ connected: false, reason: "not_ready" }));
      throw new Error(`unexpected fetch: ${url}`);
    });
    render(<UsersView deployedUrl={null} />);
    expect(await screen.findByText(/still being set up/)).toBeTruthy();
  });

  it("no longer tells anyone to 'ask to be set to' a role", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    wire();
    render(<UsersView deployedUrl="https://site.example.com" />);
    await screen.findByText("alice@example.com");
    const dialog = await openInviteDialog();
    expect(dialog.textContent).not.toMatch(/ask to be set to/i);
    fireEvent.click(within(dialog).getByRole("button", { name: /create a link to share/i }));
    await within(dialog).findByLabelText("Invite link");
    expect(within(dialog).getByRole("button", { name: /^Copy$/ }).textContent).toBe("");
    fireEvent.click(within(dialog).getByRole("button", { name: /^Copy$/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0][0]).toBe("https://site.example.com/signup?invite=tok_abc");
    expect(document.body.textContent).not.toMatch(/ask to be set to/i);
  });
});

describe("UsersView emailed invites", () => {
  const EMAILED = {
    status: 201,
    body: {
      invite_url: "https://site.example.com/signup?invite=tok_mail",
      expires_at: "2026-10-04T12:00:00.000Z",
      role: "user",
      emailed_to: "pat@example.com",
    },
  };

  it("sends the invite to the typed address and confirms who it went to", async () => {
    wire({ create: EMAILED });
    render(<UsersView deployedUrl="https://site.example.com" />);
    await screen.findByText("alice@example.com");
    const dialog = await openInviteDialog();
    const send = within(dialog).getByRole("button", { name: /Send invite/ }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Email"), { target: { value: "  Pat@Example.com " } });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(await within(dialog).findByText(/Invite sent to pat@example.com/)).toBeTruthy();
    expect(invitePosts()).toHaveLength(1);
    expect(JSON.parse((invitePosts()[0][1] as { body: string }).body)).toEqual({ role: "user", email: "Pat@Example.com" });
    expect((within(dialog).getByLabelText("Email") as HTMLInputElement).value).toBe("");
    expect(within(dialog).queryByText(/coming soon/i)).toBeNull();
  });

  it("a failed send says so, shows no link and no sent confirmation", async () => {
    wire({ create: { status: 502, body: { error: { code: "invite_email_failed", message: "x" } } } });
    render(<UsersView deployedUrl="https://site.example.com" />);
    await screen.findByText("alice@example.com");
    const dialog = await openInviteDialog();
    fireEvent.change(within(dialog).getByLabelText("Email"), { target: { value: "pat@example.com" } });
    fireEvent.submit(within(dialog).getByLabelText("Email").closest("form")!);
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "We couldn't send the invite email. Try again, or create a link instead.",
    );
    expect(within(dialog).queryByText(/Invite sent/)).toBeNull();
    expect(within(dialog).queryByLabelText("Invite link")).toBeNull();
    expect((within(dialog).getByLabelText("Email") as HTMLInputElement).value).toBe("pat@example.com");
  });

  it("Enter on a malformed address never posts", async () => {
    wire({ create: EMAILED });
    render(<UsersView deployedUrl="https://site.example.com" />);
    await screen.findByText("alice@example.com");
    const dialog = await openInviteDialog();
    fireEvent.change(within(dialog).getByLabelText("Email"), { target: { value: "pat@" } });
    fireEvent.submit(within(dialog).getByLabelText("Email").closest("form")!);
    expect((await within(dialog).findByRole("alert")).textContent).toBe("Enter a valid email address.");
    expect(invitePosts()).toHaveLength(0);
  });

  it("a double submit sends one email, not two", async () => {
    let release: (v: unknown) => void = () => {};
    wire({ create: EMAILED });
    const base = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementation((url: string, init?: { method?: string }) => {
      if (String(url) === "/api/website/app-invites" && init?.method === "POST") {
        return new Promise((r) => { release = r; }).then(() => base(url, init));
      }
      return base(url, init);
    });
    render(<UsersView deployedUrl="https://site.example.com" />);
    await screen.findByText("alice@example.com");
    const dialog = await openInviteDialog();
    fireEvent.change(within(dialog).getByLabelText("Email"), { target: { value: "pat@example.com" } });
    const form = within(dialog).getByLabelText("Email").closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    fireEvent.click(within(dialog).getByRole("button", { name: /create a link to share/i }));
    release(undefined);
    await within(dialog).findByText(/Invite sent to/);
    expect(invitePosts()).toHaveLength(1);
  });
});

describe("Overview Send Invites", () => {
  function wireConsole(opts: Parameters<typeof wire>[0] = {}) {
    wire(opts);
    const base = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementation((url: string, init?: { method?: string }) => {
      if (String(url) === "/api/website/overview?app=workspace") {
        return Promise.resolve(
          jsonRes({
            app: {
              name: "Acme",
              description: null,
              created_at: "2026-09-01T00:00:00.000Z",
              deployed_url: "https://site.example.com",
              build_status: "done",
            },
            visibility: "public",
            badge_hidden: false,
          }),
        );
      }
      return base(url, init);
    });
  }

  it("opens the Users tab with the invite dialog ready, and does not reopen it on a later visit", async () => {
    window.history.replaceState(null, "", "/workspace");
    wireConsole();
    render(<WebsiteConsole />);
    fireEvent.click(await screen.findByRole("button", { name: /Send Invites/ }));
    const dialog = await screen.findByRole("dialog", { name: "Invite to your site" });
    expect(within(dialog).getByLabelText("Email")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close invite dialog" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Overview/ }));
    fireEvent.click(await screen.findByRole("button", { name: /^Users$/ }));
    await screen.findByText("alice@example.com");
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  async function sendInvitesButton() {
    return (await screen.findByRole("button", { name: /Send Invites/ })) as HTMLButtonElement;
  }

  it("a member gets a disabled Send Invites with the reason, and no invites request is made", async () => {
    window.history.replaceState(null, "", "/workspace");
    mockRole = "member";
    wireConsole();
    render(<WebsiteConsole />);
    const send = await sendInvitesButton();
    await new Promise((r) => setTimeout(r, 20));
    expect(send.disabled).toBe(true);
    expect(send.title).toBe("Only workspace owners and admins can invite people");
    fireEvent.click(send);
    await new Promise((r) => setTimeout(r, 20));
    expect(new URLSearchParams(window.location.search).get("section")).toBe("overview");
    expect(invitesGets()).toHaveLength(0);
  });

  it("a site without roles gets a disabled Send Invites with the reason instead of a silent jump to Users", async () => {
    window.history.replaceState(null, "", "/workspace");
    wireConsole({
      columns: NO_ROLE_COLS,
      invitesStatus: 409,
      invitesBody: { error: { code: "roles_not_configured", message: "x" } },
    });
    render(<WebsiteConsole />);
    const send = await sendInvitesButton();
    await waitFor(() => expect(send.title).toBe("Roles aren\u2019t set up on this site yet"));
    expect(send.disabled).toBe(true);
    fireEvent.click(send);
    await new Promise((r) => setTimeout(r, 20));
    expect(new URLSearchParams(window.location.search).get("section")).toBe("overview");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stays disabled when the invites check fails, rather than sending the user to a dead end", async () => {
    window.history.replaceState(null, "", "/workspace");
    wireConsole({ invitesStatus: 500, invitesBody: { error: { code: "unavailable" } } });
    render(<WebsiteConsole />);
    const send = await sendInvitesButton();
    await waitFor(() => expect(send.title).toMatch(/couldn\u2019t check invites/));
    expect(send.disabled).toBe(true);
  });

  it("a site with no sign-up page gets a disabled Send Invites that says why", async () => {
    window.history.replaceState(null, "", "/workspace");
    wireConsole({ invitesBody: { connected: true, invites: [], signup_available: false } });
    render(<WebsiteConsole />);
    const send = await sendInvitesButton();
    await waitFor(() => expect(send.title).toBe("Your site has no sign-up page yet, so an invite link would open a 404. Ask Zavi to add sign-in to your site first."));
    expect(send.disabled).toBe(true);
    fireEvent.click(send);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(invitePosts()).toHaveLength(0);
  });

  it("an owner on a site with roles gets an enabled Send Invites", async () => {
    window.history.replaceState(null, "", "/workspace");
    wireConsole();
    render(<WebsiteConsole />);
    const send = await sendInvitesButton();
    await waitFor(() => expect(send.disabled).toBe(false));
    expect(send.title).toBe("");
  });

  it("a request made then abandoned before Users loads does not pop the dialog later", async () => {
    window.history.replaceState(null, "", "/workspace");
    wireConsole();
    render(<WebsiteConsole />);
    fireEvent.click(await screen.findByRole("button", { name: /Send Invites/ }));
    fireEvent.click(screen.getByRole("button", { name: /Overview/ }));
    fireEvent.click(await screen.findByRole("button", { name: /^Users$/ }));
    await screen.findByText("alice@example.com");
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
