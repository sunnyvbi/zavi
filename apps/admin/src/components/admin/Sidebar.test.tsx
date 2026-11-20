import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect, vi } from "vitest";
const path = vi.hoisted(() => ({ current: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => path.current, useRouter: () => ({ replace: () => {} }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/supabase-admin", () => ({ createBrowserAdminSupabase: () => ({ auth: { signOut: async () => ({}) } }) }));
import { Sidebar } from "./Sidebar";
import type { NavBadges } from "@/lib/overview";

function render(pathname: string, badges: NavBadges = {}, collapsed = false) {
  path.current = pathname;
  return renderToStaticMarkup(
    <Sidebar collapsed={collapsed} onToggle={() => {}} onOpenPalette={() => {}} badges={badges} />,
  );
}

const count = (html: string, s: string) => html.split(s).length - 1;

describe("Sidebar", () => {
  it("shows default pins and keeps every group closed", () => {
    const html = render("/");
    expect(html).toContain("Pinned");
    expect(count(html, 'aria-expanded="true"')).toBe(0);
    expect(count(html, 'aria-label="Unpin ')).toBe(7);
  });
  it("Panic-stop is a footer link and does not open System", () => {
    const html = render("/fleet-halt");
    expect(count(html, 'aria-expanded="true"')).toBe(0);
    expect(html).toMatch(/<a href="\/fleet-halt"[^>]*aria-current="page"/);
  });
  it("an unpinned active page opens its group with one current link", () => {
    const html = render("/config");
    expect(count(html, 'aria-expanded="true"')).toBe(1);
    expect(count(html, 'aria-current="page"')).toBe(1);
  });
  it("a pinned active page does not force its group open", () => {
    const html = render("/tenants");
    expect(count(html, 'aria-expanded="true"')).toBe(0);
    expect(count(html, 'aria-current="page"')).toBe(1);
  });
  it("a closed group with a badge says so to screen readers", () => {
    const html = render("/", { "/crons": { count: 1, tone: "red" } });
    expect(count(html, "has pages needing attention")).toBe(1);
  });
  it("the rail shows one tile per group, labelled", () => {
    const html = render("/", { "/decisions": { count: 3, tone: "amber" } }, true);
    expect(count(html, 'aria-label="Open ')).toBe(8);
    expect(html).toContain('aria-label="Open Agents, has pages needing attention"');
  });
});
