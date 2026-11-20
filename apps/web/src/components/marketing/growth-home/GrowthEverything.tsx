
import { FEATURE_COLUMNS } from "./featureColumns";

export function GrowthEverything() {
  return (
    <div className="px-3 py-4 sm:px-6">
      <div className="mx-auto overflow-hidden rounded-blockLg border border-[#e6eaef] bg-[#f8fafc]">
        <section className="w-full bg-[#f6f6f7] py-20 text-[#0e0f11] lg:py-28">
          <div className="mx-auto max-w-[1400px] px-6 lg:px-10">
            <h2 className="max-w-[18ch] text-[clamp(2rem,4.6vw,3.25rem)] font-bold leading-[1.12] tracking-[-0.02em] text-black">
              Everything you need to grow your business.
            </h2>
            <div className="mt-14 grid gap-12 sm:grid-cols-2 lg:mt-20 lg:grid-cols-4 lg:gap-8">
              {FEATURE_COLUMNS.map((col) => (
                <div key={col.title}>
                  <h3 className="text-[32px] font-normal tracking-[-0.01em] text-black lg:text-[40px]">
                    {col.title}
                  </h3>
                  <ul className="mt-8 space-y-5">
                    {col.items.map((item) => (
                      <li
                        key={item.label}
                        className="group flex items-center gap-4 text-[16px] text-[#3f3f46] lg:text-[20px]"
                      >
                        <span
                          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[12px] border border-black/[0.06] bg-white shadow-[0_1px_2px_rgba(16,18,20,0.04)] transition-transform duration-200 group-hover:scale-105"
                          style={{ color: col.color }}
                        >
                          <svg
                            aria-hidden="true"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={1.75}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="h-5 w-5"
                          >
                            {item.icon}
                          </svg>
                        </span>
                        {item.label}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
