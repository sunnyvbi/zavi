
import Link from "next/link";
import { Check, Minus } from "lucide-react";

type Row = { task: string; without: string | null };

const ROWS: Row[] = [
  { task: "Full time marketing hire", without: "$5,000/mo" },
  { task: "SEO agency", without: "$4,000/mo" },
  { task: "Content writer", without: "$1,500/mo" },
  { task: "Social media manager", without: "$1,500/mo" },
  { task: "Reddit and community growth", without: "$1,000/mo" },
  { task: "AI search visibility (GEO)", without: null },
  { task: "Checks in on your goal", without: null },
];

const CELL_X = "px-4 sm:px-8";

export function GrowthCostCompare({ startHref }: { startHref: string }) {
  return (
    <div className="px-3 py-4 sm:px-6">
      <div className="mx-auto max-w-[1200px] overflow-hidden rounded-blockLg border border-[#e6eaef] bg-[#f4f4f5]">
        <section className="w-full py-20 text-[#0e0f11] lg:py-28">
          <div className="mx-auto w-full max-w-[1000px] px-6 lg:px-10">
            <div className="mx-auto text-center">
              <p className="text-[16px] font-semibold uppercase tracking-[0.12em] text-[#595959]">
                The $14,000/mo job, starting free
              </p>
              <h2 className="mt-4 text-[clamp(1.75rem,3vw,2.4rem)] font-bold leading-[1.12] tracking-[-0.02em] text-[#0e0f11] lg:whitespace-nowrap">
                What Zavi replaces vs. what it costs
              </h2>
            </div>

            <div className="mt-12 overflow-hidden rounded-block border border-black/[0.08] bg-white shadow-[0_1px_2px_rgba(16,18,20,0.04)] lg:mt-16">
              {}
              <div
                className="relative w-full max-w-full overflow-x-auto overflow-y-hidden"
                style={{ contain: "inline-size" }}
              >
                <table className="w-full min-w-[560px] border-collapse text-left">
                  <thead>
                    <tr className="border-b border-black/[0.08] bg-[#f9f9f9]">
                      <th scope="col" className={`${CELL_X} py-4 text-[14px] font-semibold text-[#595959]`}>
                        What needs doing
                      </th>
                      <th scope="col" className={`${CELL_X} py-4 text-[14px] font-semibold text-[#595959]`}>
                        Without Zavi
                      </th>
                      <th
                        scope="col"
                        className={`bg-[#e6f2ff]/60 ${CELL_X} py-4 text-[14px] font-semibold text-[#0e0f11]`}
                      >
                        With Zavi
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {ROWS.map((row) => (
                      <tr key={row.task} className="border-b border-black/[0.06]">
                        <th
                          scope="row"
                          className={`${CELL_X} py-4 text-[14px] font-medium text-[#0e0f11] sm:text-[16px]`}
                        >
                          {row.task}
                        </th>
                        <td className={`${CELL_X} py-4 text-[14px] text-[#595959] sm:text-[16px]`}>
                          {row.without ?? (
                            <span className="inline-flex items-center gap-2 text-[#595959]">
                              <Minus aria-hidden="true" className="h-4 w-4" /> not possible
                            </span>
                          )}
                        </td>
                        <td className={`bg-[#e6f2ff]/40 ${CELL_X} py-4`}>
                          <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-[#f5faf8] text-[#167f50]">
                            <Check aria-hidden="true" className="h-4 w-4" />
                            <span className="sr-only">Included</span>
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-[#f9f9f9]">
                      <th
                        scope="row"
                        className={`${CELL_X} py-4 text-[16px] font-bold text-[#0e0f11] sm:text-[20px]`}
                      >
                        Total per month
                      </th>
                      <td className={`${CELL_X} py-4 text-[16px] font-bold text-[#0e0f11] sm:text-[20px]`}>
                        $14,000+
                      </td>
                      <td
                        className={`bg-[#e6f2ff]/60 ${CELL_X} py-4 text-[16px] font-bold text-[#027bff] sm:text-[20px]`}
                      >
                        <Link
                          href={startHref}
                          prefetch={false}
                          className="rounded-sm underline decoration-2 underline-offset-4 transition-opacity duration-200 hover:opacity-75"
                        >
                          Start with free
                        </Link>
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
