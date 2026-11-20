
import { NoWebsiteNote, WebsiteForm } from "./GrowthHero";
import { StepGlyph } from "./stepIcons";
import { jakartaHeavy } from "./fonts";

const HEADING = "Let AI grow your business";
const SUBHEAD = "Agents that find what to fix in your ads, SEO, and landing pages, draft the change, and wait for your approval.";

const CHIPS: [string, string][] = [
  ["Reddit", "Reddit"],
  ["SEO", "SEO"],
  ["GEO (AI search)", "GEO"],
  ["X", "X"],
  ["Instagram", "Instagram"],
  ["LinkedIn Ads", "LinkedIn"],
  ["UGC Videos", "UGC Videos"],
  ["Email", "Email"],
  ["Meta Ads", "Meta Ads"],
];
const INK_MARKS = new Set(["SEO", "GEO", "X", "UGC Videos", "Email"]);

export function GrowthFinalCta({ startHref, framed = true }: { startHref: string; framed?: boolean }) {
  return (
    <section className="w-full bg-white py-16 lg:py-20">
      <div className={`mx-auto w-full px-3 sm:px-6 ${framed ? "max-w-[1180px]" : ""}`}>
        <div className="relative overflow-hidden rounded-blockLg bg-[#0e0f11] px-6 py-16 text-white sm:px-10 lg:px-14 lg:py-20">
          <div className="relative mx-auto max-w-[720px] text-center">
            {}
            <h2
              className={`${jakartaHeavy.className} mx-auto text-[clamp(1.6rem,4.4vw,3.25rem)] font-extrabold leading-[1.08] tracking-[-0.03em] sm:whitespace-nowrap`}
            >
              {HEADING}
            </h2>
            <p className="mx-auto mt-5 max-w-[48ch] text-[16px] leading-relaxed text-white/70">{SUBHEAD}</p>

            <WebsiteForm
              startHref={startHref}
              id="cta-site"
              tone="dark"
              variant="solid"
              className="mx-auto mt-9 w-full max-w-[560px]"
              note={<NoWebsiteNote tone="dark" small startHref={startHref} />}
            />

            <ul className="mx-auto mt-10 flex max-w-[640px] flex-wrap justify-center gap-2">
              {CHIPS.map(([label, icon]) => (
                <li
                  key={label}
                  className="inline-flex min-h-9 items-center gap-2 rounded-full border border-white/[0.12] bg-white/[0.06] px-3.5 text-[16px] font-medium text-white/85 transition-colors duration-200 hover:border-white/25 hover:bg-white/[0.1]"
                >
                  <span className="flex h-5 w-5 items-center justify-center">
                    <StepGlyph
                      name={icon}
                      className="h-4 w-4"
                      color={INK_MARKS.has(icon) ? "#ffffff" : undefined}
                    />
                  </span>
                  {label}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
