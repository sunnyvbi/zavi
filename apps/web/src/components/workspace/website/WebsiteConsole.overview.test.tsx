
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OverviewView } from "./WebsiteConsole";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));

type Payload = Parameters<typeof OverviewView>[0]["data"];

function payload(over: Partial<Payload> = {}): Payload {
  return {
    app: {
      name: "Design Marketplace",
      description: "A marketplace for design assets.",
      created_at: "2026-07-14T00:00:00.000Z",
      deployed_url: "https://example.onrender.com",
      build_status: "done",
    },
    visibility: "public",
    badge_hidden: false,
    ...over,
  } as Payload;
}

function render(over: Partial<Payload> = {}, usageRunIds: string[] | null = null, canManage = true) {
  return renderToStaticMarkup(
    <OverviewView
      data={payload(over)}
      canManage={canManage}
      onPatch={async () => true}
      onOpenSettings={() => {}}
      onSendInvites={() => {}}
      usageRunIds={usageRunIds}
    />,
  );
}

describe("OverviewView — App Visibility is hidden until it is enforced", () => {
  it("offers no visibility control at all, even for a tenant with a stored private value", () => {
    for (const visibility of ["public", "private", "unlisted"] as const) {
      const html = render({ visibility });
      expect(html).not.toContain("App Visibility");
      expect(html).not.toContain("Private");
      expect(html).not.toContain("Unlisted");
      expect(html).not.toContain('role="listbox"');
      expect(html).not.toMatch(/coming soon/i);
      expect(html).not.toContain("Control who can access your application");
    }
  });
});

describe("OverviewView — Platform Badge toggle", () => {
  it("does not assert a specific present-tense visibility state it cannot know", () => {
    expect(render({ badge_hidden: false })).not.toContain("is currently visible on");
    expect(render({ badge_hidden: true })).not.toContain("is currently visible on");
  });

  it("describes the badge as a live control on the deployed app", () => {
    const html = render();
    expect(html).toContain("appears on your live app");
    expect(html).not.toContain("badge injection ships");
  });

  it("renders a working Hide/Show Badge toggle reflecting badge_hidden", () => {
    expect(render({ badge_hidden: false })).toContain("Hide Badge");
    expect(render({ badge_hidden: true })).toContain("Show Badge");
  });
});

describe("OverviewView — dead controls are gone", () => {
  it('has no "Earn credits" button', () => {
    expect(render()).not.toContain("Earn credits");
  });

  it("still offers View usage outside a build", () => {
    expect(render()).toContain("View usage");
    expect(render()).not.toContain("App usage");
  });

  it("inside a build, replaces View usage with this app's own usage card", () => {
    const html = render({}, ["run-root", "refine-1", "refine-2"]);
    expect(html).toContain("App usage");
    expect(html).toContain("Credits spent building and changing this app.");
    expect(html).toContain("Billing &amp; credits");
    expect(html).not.toContain("View usage");
  });
});

describe("OverviewView — surviving behaviour (regression guard)", () => {
  it("offers an editable app-details control instead of a disabled rename icon", () => {
    const html = render();
    expect(html).toContain('aria-label="Edit app details"');
    expect(html).not.toContain("Rename (coming soon)");
  });

  it("renders the app name and description", () => {
    const html = render();
    expect(html).toContain("Design Marketplace");
    expect(html).toContain("A marketplace for design assets.");
  });

  it("omits the description paragraph when the API returns null (plan-shape suppressed upstream)", () => {
    const html = render({
      app: { ...payload().app, description: null },
    } as Partial<Payload>);
    expect(html).toContain("Design Marketplace");
    expect(html).not.toContain("A marketplace for design assets.");
  });

  it("offers Copy Link when a deployed URL exists", () => {
    expect(render()).toContain("Copy Link");
  });

  it("disables Copy Link when there is no deployed URL", () => {
    const html = render({
      app: { ...payload().app, deployed_url: null },
    } as Partial<Payload>);
    expect(html).toContain("Copy Link");
    expect(html).toContain("disabled");
  });

  it("offers a live Send Invites action with no coming-soon signpost", () => {
    const html = render();
    const send = html.match(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Send Invites(?:(?!<\/button>)[\s\S])*<\/button>/);
    expect(send).toBeTruthy();
    expect(send![0]).not.toMatch(/\sdisabled(=|\s|>)/);
    expect(send![0]).toContain("min-w-max");
    expect(html).not.toContain("Email invites are coming soon");
    expect(html).not.toMatch(/>Soon</);
    expect(html).toContain("max-w-[840px]");
  });

  it("disables Send Invites until the app is published", () => {
    const html = render({ app: { ...payload().app, deployed_url: null } } as Partial<Payload>);
    const send = html.match(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Send Invites(?:(?!<\/button>)[\s\S])*<\/button>/);
    expect(send![0]).toMatch(/\sdisabled(=|\s|>)/);
    expect(send![0]).toContain("Publish your app before inviting people");
  });
});

describe("OverviewView more-actions menu", () => {
  it("uses the app's popover radius with rounded rows, not a square-cornered list", () => {
    const source = readFileSync(join(__dirname, "WebsiteConsole.tsx"), "utf8");
    const menu = source.match(/role="menu"\s+className="([^"]*)"/);
    expect(menu).toBeTruthy();
    expect(menu![1]).toContain("rounded-xl");
    expect(menu![1]).toContain("p-1");
    expect(menu![1]).not.toContain("rounded-lg");
    const rows = source.match(/role="menuitem"[\s\S]*?className="([^"]*)"/g) ?? [];
    expect(rows.length).toBe(3);
    for (const row of rows) expect(row).toContain("rounded-lg");
  });
});

describe("OverviewView — members cannot change app settings", () => {
  const badgeButton = (html: string) =>
    html.match(/<button[^>]*>(?:(?!<button).)*?(?:Hide|Show) Badge<\/button>/s)?.[0] ?? "";

  it("hides the edit control and disables the badge toggle for a member", () => {
    const html = render({}, null, false);
    expect(html).not.toContain('aria-label="Edit app details"');
    expect(badgeButton(html)).toMatch(/^<button[^>]*disabled=""/);
    expect(html).toContain("Only owners and admins can change this");
  });

  it("keeps both controls live for an owner or admin", () => {
    const html = render({}, null, true);
    expect(html).toContain('aria-label="Edit app details"');
    expect(badgeButton(html)).not.toMatch(/^<button[^>]*disabled=""/);
    expect(html).not.toContain("Only owners and admins can change this");
  });
});
