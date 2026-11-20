
import Link from "next/link";
import type { ReactNode } from "react";
import { UserMenu } from "@/components/UserMenu";

const NAV_ITEMS = [
  { href: "/tools", label: "Tools" },
  { href: "/map", label: "Map" },
  { href: "/workspace", label: "Agents" },
  { href: "/playbooks", label: "Playbooks" },
  { href: "/artifacts", label: "Artifacts" },
  { href: "/roles", label: "Roles" },
  { href: "/applications", label: "Applications" },
  { href: "/connectors", label: "Connectors" },
  { href: "/inbox", label: "Inbox" },
];

export function AppShell({
  children,
  rightRail,
  pageTitle,
  tenantName,
  userEmail,
}: {
  children: ReactNode;
  rightRail?: ReactNode;
  pageTitle?: string;
  tenantName?: string;
  userEmail?: string;
}) {
  return (
    <div className="min-h-screen text-ink bg-bone">
      {}
      <a href="#zavi-main" className="skip-to-main">Skip to main content</a>
      <header className="sticky top-0 z-40 border-b border-ink/10 bg-white/70 backdrop-blur-xl">
        <div className="mx-auto max-w-[1240px] px-6 md:px-10 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/" className="flex items-center gap-2.5">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-ink text-white text-[13px] font-semibold tracking-tight">
                Z
              </span>
              <span className="font-semibold text-[16px] tracking-tight text-ink">Zavi</span>
            </Link>
            <span className="hidden md:inline text-ink/30">/</span>
            <span className="hidden md:inline text-[13px] text-inkMuted">{pageTitle ?? "Operator workspace"}</span>
          </div>
          <div className="flex items-center gap-3 text-[13px] text-inkMuted">
            {tenantName && (
              <>
                <span className="hidden md:inline-flex items-center gap-2">
                  {}
                  <span
                    className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-bone text-ink text-[11px] font-semibold tracking-tight"
                    aria-hidden="true"
                  >
                    {tenantName.charAt(0).toUpperCase()}
                  </span>
                  <span className="font-mono uppercase tracking-[0.14em]">
                    {tenantName}
                  </span>
                </span>
                <span className="hidden md:inline text-ink/30">·</span>
              </>
            )}
            {userEmail && <UserMenu email={userEmail} />}
            <Link
              href="/"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-ink/10 bg-white text-inkMuted hover:border-ink/25 hover:text-ink transition-colors"
              aria-label="Help"
            >
              ?
            </Link>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1240px] px-6 md:px-10 py-8 grid grid-cols-12 gap-6">
        <main id="zavi-main" className="col-span-12 lg:col-span-8">{children}</main>
        <aside
          className="col-span-12 lg:col-span-4 lg:border-l lg:border-ink/10 lg:pl-6"
          aria-label="Workspace context"
        >
          <RightRailTabs />
          <div className="mt-5">{rightRail}</div>
        </aside>
      </div>
    </div>
  );
}

function RightRailTabs() {
  return (
    <nav className="flex flex-wrap gap-x-4 gap-y-2 text-[13px] pb-3 border-b border-ink/10">
      {NAV_ITEMS.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className="text-inkMuted hover:text-violet transition-colors"
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
