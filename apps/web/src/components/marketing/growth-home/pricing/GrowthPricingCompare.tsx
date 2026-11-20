
import Link from "next/link";
import { CHANNELS, ChannelIcon, GROUP_LABEL, PLANS, type ChannelGroup } from "./pricingData";

const GROUPS: ChannelGroup[] = ["core", "organic", "paid"];

const SHORT_NAME: Record<string, string> = {
  website: "Website Analysis",
  strategy: "Growth Strategy",
  seo: "SEO",
  geo: "GEO",
  reddit: "Reddit",
  x: "X",
  linkedin: "LinkedIn",
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  email: "Email",
  sms: "SMS",
  "meta-ads": "Meta Ads",
  "google-ads": "Google Ads",
  "tiktok-ads": "TikTok Ads",
  "reddit-ads": "Reddit Ads",
  "linkedin-ads": "LinkedIn Ads",
  "youtube-ads": "YouTube Ads",
  ugc: "UGC Videos",
};

const ROW_TH = "border-t border-dashed border-black/10 px-4 py-4 align-middle font-normal";
const CELL = "border-t border-dashed border-black/10 px-4 py-4 text-center";

function RowLabel({ title, sub }: { title: string; sub: string }) {
  return (
    <th scope="row" className={ROW_TH}>
      <span className="block text-[16px] font-semibold text-[#0e0f11]">{title}</span>
      <span className="mt-1 block text-[13px] leading-snug text-[#595959]">{sub}</span>
    </th>
  );
}

export function GrowthPricingCompare({ startHref }: { startHref: string }) {
  return (
    <section id="compare-plans" className="w-full scroll-mt-24 px-6 py-16 text-[#0e0f11] lg:px-10 lg:py-20">
      <div className="mx-auto max-w-[1180px]">
        <div className="flex flex-col items-center gap-3 text-center">
          <h2 className="text-[clamp(2rem,4.2vw,3rem)] font-bold leading-[1.1] tracking-[-0.02em] text-[#0e0f11]">
            Compare plans
          </h2>
          <p className="text-[16px] text-[#595959]">Pick the channels you want Zavi to run.</p>
        </div>
        <div className="mt-10 overflow-hidden rounded-[28px] bg-[#f6f6f7] p-2 sm:p-3">
          <div className="relative w-full max-w-full overflow-x-auto" style={{ contain: "inline-size" }}>
            <table className="w-full min-w-[760px] border-separate border-spacing-0 text-left">
              <thead>
                <tr>
                  <th
                    scope="col"
                    className="w-[34%] px-4 pb-4 pt-5 align-bottom text-[13px] font-semibold uppercase tracking-[0.12em] text-[#595959]"
                  >
                    What&apos;s included
                  </th>
                  {PLANS.map((p) => (
                    <th
                      key={p.id}
                      scope="col"
                      className={`px-4 pb-4 pt-5 text-center align-bottom ${p.popular ? "rounded-t-[20px] bg-white" : ""}`}
                    >
                      {p.popular && (
                        <span className="mb-2 inline-block rounded-full bg-[#1fa463] px-2.5 py-0.5 text-[12px] font-semibold text-white">
                          Most popular
                        </span>
                      )}
                      <span className="block text-[20px] font-bold text-[#0e0f11]">{p.short}</span>
                      <span className="mt-0.5 block text-[16px] text-[#595959]">
                        {p.monthly > 0 ? (
                          <>
                            <span className="font-semibold text-[#0e0f11]">${p.monthly}</span>/mo
                          </>
                        ) : (
                          "Free forever"
                        )}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {GROUPS.map((group) => {
                  const channels = CHANNELS.filter((c) => c.group === group);
                  return (
                    <tr key={group}>
                      <RowLabel title={GROUP_LABEL[group]} sub={channels.map((c) => SHORT_NAME[c.id]).join(" · ")} />
                      {PLANS.map((p) => (
                        <td key={p.id} className={`${CELL} ${p.popular ? "bg-white" : ""}`}>
                          {p.groups.includes(group) ? (
                            <span className="flex flex-col items-center gap-2">
                              <span className="flex items-center justify-center pl-1.5">
                                {channels.map((c) => (
                                  <span key={c.id} className="-ml-1.5 rounded-[10px] ring-2 ring-white">
                                    <ChannelIcon channel={c} />
                                  </span>
                                ))}
                              </span>
                              <span className="text-[13px] font-medium text-[#595959]">All {channels.length}</span>
                            </span>
                          ) : (
                            <span className="text-[16px] text-black/30">Not included</span>
                          )}
                        </td>
                      ))}
                    </tr>
                  );
                })}
                <tr>
                  <RowLabel
                    title="Every plan includes"
                    sub="Approval before anything goes live · Slack & Microsoft Teams · Founder-led support · Cancel anytime"
                  />
                  {PLANS.map((p) => (
                    <td key={p.id} className={`${CELL} ${p.popular ? "bg-white" : ""}`}>
                      <span
                        aria-hidden="true"
                        className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-[#dcfce7] text-[#16a34a]"
                      >
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={3}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="h-4 w-4"
                        >
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                      </span>
                      <span className="sr-only">Included</span>
                    </td>
                  ))}
                </tr>
                <tr>
                  <td className="px-4 pb-5 pt-3" />
                  {PLANS.map((p) => (
                    <td
                      key={p.id}
                      className={`px-4 pb-5 pt-3 text-center ${p.popular ? "rounded-b-[20px] bg-white" : ""}`}
                    >
                      <Link
                        href={startHref}
                        prefetch={false}
                        className={`inline-flex h-11 w-full max-w-[180px] items-center justify-center rounded-[12px] text-[14px] font-semibold transition-opacity duration-200 hover:opacity-90 ${
                          p.popular
                            ? "bg-[#0e0f11] text-white"
                            : "border border-black/[0.12] bg-white text-[#0e0f11]"
                        }`}
                      >
                        {p.cta}
                      </Link>
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  );
}
