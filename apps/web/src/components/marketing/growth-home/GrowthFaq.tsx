
export type FaqItem = { q: string; a: string };

const FAQS: FaqItem[] = [
  {
    q: "What is an AI growth agent?",
    a: "An AI growth agent is software that runs your growth work autonomously. It reads your channels, finds what is holding the numbers back, and ships fixes, instead of just handing you a dashboard of warnings. Zavi goes a step further: it also tracks how your brand appears in AI answers across ChatGPT, Claude, Perplexity and Gemini, so you're optimising for both Google and the engines buyers increasingly ask.",
  },
  {
    q: "What does the automated audit include?",
    a: "Zavi reads your site and every connected channel: paid ads, search, social, email and your codebase. It flags what is costing you money, what is missing, and what is broken, and pairs each finding with the change it would make and the money it expects to move.",
  },
  {
    q: "What is GEO / AI visibility tracking?",
    a: "GEO is generative engine optimisation. Zavi checks how, and whether, your brand shows up when people ask ChatGPT, Claude, Perplexity or Gemini about your category, then drafts the content and structure changes that get you cited.",
  },
  {
    q: "How is Zavi different from an SEO tool or a dashboard?",
    a: "Tools report. Zavi does the work. It writes the code, moves the ad budget, drafts the posts and the pages, and brings each change to you for a yes before anything goes live.",
  },
  {
    q: "Can Zavi replace an agency?",
    a: "For most small and mid-sized businesses, yes: the everyday work an agency bills for is exactly what Zavi runs daily. You keep control of every decision, and you can bring in specialists on top whenever you want to.",
  },
  {
    q: "How often do I get fixes and recommendations?",
    a: "Daily. Zavi reads the numbers every morning and sends you what changed, what it recommends, and what it needs approved. Urgent issues, like a broken checkout, come through as soon as they're found.",
  },
  {
    q: "Do I need technical knowledge to use this?",
    a: "No. You describe what you want in plain language and Zavi explains every recommendation the same way, with the numbers behind it. Anything technical, like a code fix, is shown as a diff you can read or hand to a developer.",
  },
  {
    q: "Can I connect Google Search Console and Analytics?",
    a: "Yes. Google Analytics and Search Console connect in two clicks, alongside Meta Ads, Google Ads, Shopify, HubSpot, Slack and the rest of the connectors. Each one lets Zavi act on real data rather than estimates.",
  },
  {
    q: "How quickly will I see results?",
    a: "You'll see your first recommendations within minutes of connecting a channel. Paid changes, like budget moves, show up in the numbers within days; organic work, like SEO and AI visibility, compounds over weeks.",
  },
];

export const PRICING_FAQS: FaqItem[] = [
  {
    q: "Can I start for free?",
    a: "Yes. Zavi Free includes website analysis, your growth strategy and the SEO agent, with no credit card. Upgrade when you want Zavi running more channels.",
  },
  {
    q: "What's the difference between Lite and Pro?",
    a: "Lite runs every organic channel: SEO, AI search, Reddit, X, LinkedIn, Instagram, TikTok, YouTube, email and SMS. Pro adds every paid channel: Meta, Google, TikTok, Reddit, LinkedIn and YouTube ads, plus UGC video ads.",
  },
  {
    q: "Is my ad spend included in the plan?",
    a: "No. Your plan covers Zavi. Ad spend is billed by each ad platform to your own ad account, and Zavi only moves budget you approve.",
  },
  {
    q: "How does annual billing work?",
    a: "Pay for the year up front and save 20% on Lite or Pro. That's more than two months free compared with paying monthly.",
  },
  {
    q: "Can I cancel anytime?",
    a: "Yes. Cancel from your settings in a couple of clicks. Your plan stays active until the end of the period you've paid for.",
  },
  {
    q: "Does Zavi publish anything without asking?",
    a: "No. Every post, page, email and budget change comes to you as a plain-English proposal first. Nothing goes live until you say yes.",
  },
  {
    q: "Do you have plans for agencies or several brands?",
    a: "Yes. Custom plans cover multiple brands or clients, with a named growth partner and weekly reviews. Contact us and we'll size it to you.",
  },
];

export function GrowthFaq({
  items = FAQS,
  title = "Frequently asked questions",
}: {
  items?: FaqItem[];
  title?: string;
}) {
  return (
    <section id="faq" className="w-full scroll-mt-28 py-20 text-[#0e0f11] lg:py-28">
      <div className="mx-auto w-full max-w-[1180px] px-6 lg:px-10">
        <div className="grid gap-10 lg:grid-cols-[300px_1fr] lg:gap-16">
          <div className="lg:sticky lg:top-28 lg:self-start">
            <p className="text-[16px] font-semibold uppercase tracking-[0.12em] text-[#595959]">
              Got questions?
            </p>
            <h2 className="mt-4 text-[clamp(2rem,4vw,2.75rem)] font-bold leading-[1.12] tracking-[-0.02em] text-[#0e0f11]">
              {title}
            </h2>
          </div>
          <div className="divide-y divide-black/[0.08] border-y border-black/[0.08]">
            {items.map((item, i) => (
              <details key={item.q} open={i === 0} className="group">
                <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-6 py-4 text-left text-[16px] font-semibold text-[#0e0f11] marker:hidden [&::-webkit-details-marker]:hidden">
                  {item.q}
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="h-5 w-5 shrink-0 text-[#595959] transition-transform duration-200 group-open:rotate-45"
                  >
                    <path d="M5 12h14" />
                    <path d="M12 5v14" />
                  </svg>
                </summary>
                <p className="max-w-[70ch] pb-6 text-[16px] leading-relaxed text-[#595959]">{item.a}</p>
              </details>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
