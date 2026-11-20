
import Link from "next/link";
import { CREATOR_MARKETPLACE_ENABLED } from "@zavi/shared";
import { ZaviWordmark } from "./ZaviWordmark";
import { DotWordmark } from "./DotWordmark";
import { CookiePrefsButton } from "../CookiePrefsButton";
import { ZaviMascot } from "@/components/ZaviMascot";
import { COMPARISONS, pathForComparison } from "@/lib/marketing/comparisons";

const LINK =
  "inline-flex min-h-10 items-center rounded-md text-[14px] font-medium text-[#0e0f11] transition-colors duration-200 hover:text-[#595959]";

export type FooterLink = { label: string; href: string };
export type FooterGroup = { heading: string; links: FooterLink[] };

export function footerGroups(startHref: string): FooterGroup[] {
  return [
    {
      heading: "Product",
      links: [
        { label: "Channels", href: "/channels" },
        { label: "SEO agent", href: "/channels/seo" },
        { label: "Pricing", href: "/pricing" },
        { label: "Use cases", href: "/use-cases" },
        { label: "Tools", href: "/tools" },
        { label: "Leaderboard", href: "/growth" },
        { label: "Blog", href: "/blog" },
        { label: "Tutorials", href: "/tutorials" },
        { label: "Integration", href: startHref },
        { label: "Zavi for Slack", href: startHref },
        { label: "Zavi for Teams", href: startHref },
      ],
    },
    {
      heading: "Compare",
      links: COMPARISONS.map((c) => ({ label: `Zavi vs ${c.other}`, href: pathForComparison(c.slug) })),
    },
    {
      heading: "Company",
      links: [
        { label: "About", href: "/about" },
        { label: "Support", href: "/support" },
        { label: "Careers", href: "/careers" },
        { label: "Security", href: "/security" },
        ...(CREATOR_MARKETPLACE_ENABLED
          ? [
              { label: "For creators", href: "/creators" },
              { label: "Affiliates", href: "/affiliates" },
            ]
          : []),
        { label: "Sign in", href: "/login" },
        { label: "Get started", href: startHref },
      ],
    },
    {
      heading: "Legal",
      links: [
        { label: "Privacy Policy", href: "/privacy" },
        { label: "Terms of Service", href: "/terms" },
        { label: "Cookie Policy", href: "/cookie-policy" },
        { label: "Sub-processors", href: "/legal/subprocessors" },
      ],
    },
  ];
}

export function GrowthFooter({ startHref }: { startHref: string }) {
  const groups = footerGroups(startHref);

  return (
    <footer aria-label="Site footer" className="w-full shrink-0">
      <div className="w-full overflow-hidden bg-[#f6f6f7]">
        <div className="mx-auto max-w-[1340px] px-6 pt-10 sm:px-10 lg:px-14 lg:pt-12">
          <div className="flex flex-col gap-8 lg:flex-row lg:items-start lg:justify-between lg:gap-16">
            {}
            <div className="flex w-fit items-center gap-4">
              <Link href="/" aria-label="Zavi home" className="inline-flex min-h-11 w-fit items-center rounded-lg">
                <ZaviWordmark className="h-9 w-auto text-[#0e0f11] sm:h-10" />
              </Link>
              <ZaviMascot size={64} />
            </div>
            <nav aria-label="Footer" className="grid grid-cols-2 gap-x-8 gap-y-8 sm:grid-cols-4 sm:gap-x-12 lg:gap-x-14">
              {groups.map((g) => (
                <section key={g.heading} aria-labelledby={`footer-${g.heading}`}>
                  <h2 id={`footer-${g.heading}`} className="pb-1 text-[12px] font-semibold uppercase tracking-[1px] text-[#595959]">
                    {g.heading}
                  </h2>
                  <ul>
                    {g.links.map((l) => (
                      <li key={l.label}>
                        <Link href={l.href} prefetch={false} className={LINK}>
                          {l.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </nav>
          </div>
          <div className="mt-8 flex flex-col gap-2 text-[16px] text-[#595959] sm:flex-row sm:items-center sm:justify-between">
            {}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <p>© {new Date().getFullYear()} Zavi Labs, Inc. All rights reserved.</p>
              <CookiePrefsButton className="inline-flex min-h-10 items-center rounded-md underline-offset-4 transition-colors duration-200 hover:text-[#0e0f11] hover:underline">
                Cookie preferences
              </CookiePrefsButton>
            </div>
            <p>Your growth superagent.</p>
          </div>
        </div>
        <div className="mt-4 pb-4">
          <DotWordmark rows={12} />
        </div>
      </div>
    </footer>
  );
}
