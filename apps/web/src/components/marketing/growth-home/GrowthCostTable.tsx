
import Link from "next/link";
import { ArrowRight, Check, X } from "lucide-react";
import { ZaviWordmark } from "./ZaviWordmark";

const HEADING = "What Zavi replaces vs. what it costs";

const ROWS = [
  "Paid ads across Meta & Google (Pro)",
  "SEO that keeps ranking",
  "Content & copywriting",
  "Social media management",
  "Reddit & community growth",
  "AI search visibility (GEO)",
  "Checks in on the goal you set",
];

const OTHERS_COST = "$14,000+";
const ZAVI_COST = "From $0";

const ZAVI_CELL = "bg-[#e6f2ff]";

export function GrowthCostTable({ startHref }: { startHref: string }) {
  return (
    <section className="w-full bg-white py-20 text-[#0e0f11] lg:py-28">
      <div className="mx-auto w-full max-w-[920px] px-6">
        <div className="text-center">
          {}
          <h2 className="mx-auto text-[clamp(1.75rem,3.6vw,2.75rem)] font-bold leading-[1.1] tracking-[-0.02em] text-[#0e0f11] sm:text-nowrap">
            {HEADING}
          </h2>
        </div>

        <div className="mt-12 overflow-hidden rounded-block border border-black/[0.08] bg-white shadow-[0_24px_60px_-40px_rgba(16,18,20,0.25)] lg:mt-16">
          <div className="w-full max-w-full overflow-x-auto" style={{ contain: "inline-size" }}>
            <table className="w-full table-fixed border-collapse text-left">
              <colgroup>
                <col />
                <col className="w-[64px] sm:w-[140px]" />
                <col className="w-[108px] sm:w-[160px]" />
              </colgroup>
              <thead>
                <tr className="border-b border-black/[0.08]">
                  <th className="break-words px-3 py-4 text-[13px] font-semibold leading-snug text-[#595959] sm:px-6 sm:py-4 sm:text-[14px]">
                    Everything you need to grow
                  </th>
                  <th className="px-1 py-4 text-center text-[13px] font-semibold text-[#595959] sm:px-4 sm:py-4 sm:text-[14px]">
                    Others
                  </th>
                  <th className={`px-2 py-4 text-center align-middle sm:px-4 sm:py-4 ${ZAVI_CELL}`}>
                    <ZaviWordmark className="mx-auto h-5 w-auto text-[#0e0f11]" />
                  </th>
                </tr>
              </thead>
              <tbody>
                {ROWS.map((row) => (
                  <tr key={row} className="border-t border-black/[0.06]">
                    <th
                      scope="row"
                      className="break-words px-3 py-3.5 text-[13px] font-medium leading-snug text-[#0e0f11] sm:px-6 sm:py-4 sm:text-[16px]"
                    >
                      {row}
                    </th>
                    <td className="px-2 py-3.5 text-center sm:px-4 sm:py-4">
                      <X aria-label="Not included" className="mx-auto h-5 w-5 text-[#9ca3af]" />
                    </td>
                    <td className={`px-2 py-3.5 text-center sm:px-4 sm:py-4 ${ZAVI_CELL}`}>
                      <span className="mx-auto flex h-6 w-6 items-center justify-center rounded-full bg-[#0e0f11] text-white">
                        <Check aria-label="Included" className="h-3.5 w-3.5" strokeWidth={2.5} />
                      </span>
                    </td>
                  </tr>
                ))}
                <tr className="border-t-2 border-black/[0.1]">
                  <th scope="row" className="break-words px-3 py-4 text-[13px] font-bold leading-snug text-[#0e0f11] sm:px-6 sm:py-4 sm:text-[16px]">
                    Cost per month
                  </th>
                  <td className="px-0.5 py-4 text-center text-[12px] font-extrabold tabular-nums text-[#0e0f11] sm:px-4 sm:py-4 sm:text-[22px]">
                    {OTHERS_COST}
                  </td>
                  <td className={`px-2 py-4 text-center align-middle sm:px-4 sm:py-4 ${ZAVI_CELL}`}>
                    <p className="text-[14px] font-extrabold text-[#0e0f11] sm:text-[22px]">{ZAVI_COST}</p>
                    {}
                    <Link
                      href="/pricing"
                      prefetch={false}
                      className="mt-1 block text-[11px] font-medium text-[#595959] underline-offset-2 hover:underline sm:text-[13px]"
                    >
                      Channels from Starter · Ads on Pro
                    </Link>
                    <Link
                      href={startHref}
                      prefetch={false}
                      className="mt-2 inline-flex h-8 w-full items-center justify-center gap-2 whitespace-nowrap rounded-full bg-[#0e0f11] px-2 text-[13px] font-semibold text-white transition-opacity duration-200 hover:opacity-90 sm:h-9 sm:w-auto sm:px-4 sm:text-[16px]"
                    >
                      Start free
                      <ArrowRight aria-hidden="true" className="hidden h-4 w-4 sm:block" />
                    </Link>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  );
}
