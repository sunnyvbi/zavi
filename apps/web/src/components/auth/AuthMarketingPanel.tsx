
import { AuthOtpAnimation } from "@/components/auth/AuthOtpAnimation";
import { ZaviMascot } from "@/components/ZaviMascot";
import { ZaviWordmark } from "@/components/marketing/ZaviWordmark";
import {
  WEBSITE_AUTH_CHECKS,
  WEBSITE_AUTH_HEADLINE,
  useWebsiteFraming,
} from "@/lib/workspace/buildFraming";

const CHECKS: string[] = [
  "Learns how your business works.",
  "Finds what is slowing growth.",
  "Makes a clear plan and puts it to work.",
];

const PROOF = "Built by operators from";

const LIVE_HEADLINE = "Your growth card is on its way.";
const LIVE_CHECKS: string[] = [
  "Your growth card lands in your inbox.",
  "Zavi opens on your goal, with your score and #1 constraint.",
  "You approve before anything goes out.",
];

const LOGOS = [
  { src: "/marketing/growth-home/logos/upwork.svg", label: "Upwork", h: 24 },
  { src: "/marketing/growth-home/logos/amazon.svg", label: "Amazon", h: 26 },
  { src: "/logos/upcar.png", label: "Upcar", h: 20 },
  { src: "/marketing/growth-home/logos/airbnb.svg", label: "Airbnb", h: 28 },
  { src: "/marketing/growth-home/logos/meta.svg", label: "Meta", h: 22 },
] as const;

const ONBOARDING_LOGOS = LOGOS.filter((logo) => logo.label !== "Upcar");

function Tick() {
  return (
    <svg
      viewBox="0 0 20 20"
      className="h-5 w-5 shrink-0 text-[#0e0f11]"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4.5 10.5l3.5 3.5 7.5-8" />
    </svg>
  );
}

export function AuthMarketingPanel({
  variant,
  fromWebsite = false,
  otpSent = false,
}: { variant?: "build" | "live"; fromWebsite?: boolean; otpSent?: boolean } = {}) {
  const websiteFraming = useWebsiteFraming(variant === "build");
  const website = variant === "build" && websiteFraming === true;
  const pending = variant === "build" && websiteFraming === null;
  const live = variant === "live";
  const headline = live
    ? LIVE_HEADLINE
    : website
      ? WEBSITE_AUTH_HEADLINE
      : "Meet Zavi, your AI teammate for growing your business.";
  const checks = live ? LIVE_CHECKS : website ? WEBSITE_AUTH_CHECKS : CHECKS;
  if (fromWebsite && otpSent) {
    return (
      <aside
        aria-hidden="true"
        className="sticky top-0 hidden h-screen w-[44%] max-w-[680px] shrink-0 self-start p-3 lg:block"
      >
        <div
          className="relative flex h-full flex-col overflow-hidden rounded-[32px] border border-black/[0.06] bg-cover bg-center"
          style={{ backgroundImage: "url('/start-bg.webp')" }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/zavi-wordmark.png" alt="" className="absolute left-8 top-7 h-[26px] w-auto" />
          <div className="m-auto w-full max-w-[500px] px-8 pb-8 pt-20 font-[family-name:var(--font-body)]">
            <div className="mb-6">
              <ZaviMascot size={96} />
            </div>
            <h2 className="mb-6 text-center text-[26px] font-semibold leading-snug text-[#0b0b0b]">
              Your code is on its way.
            </h2>
            <AuthOtpAnimation />
          </div>
        </div>
      </aside>
    );
  }
  return (
    <aside
      aria-hidden="true"
      className={`sticky top-0 hidden h-screen shrink-0 self-start p-4 lg:block ${fromWebsite ? "lg:w-[43%]" : "lg:w-[30%] xl:w-[35%]"}`}
    >
      <div
        className="relative h-full w-full overflow-hidden rounded-[40px] border border-[#f0f0f0] bg-white"
        style={{
          backgroundImage: "url('/start-bg.webp')",
          backgroundSize: "cover",
          backgroundPosition: "bottom right",
          backgroundRepeat: "no-repeat",
        }}
      >
        {}
        {fromWebsite && (
          <div className="absolute left-8 top-8">
            <ZaviWordmark markless size="lg" />
          </div>
        )}
        <div className="absolute inset-0 flex items-center px-[14%]">
          <div className="flex w-full flex-col gap-10">
            <div className={`flex flex-col gap-9${pending ? " invisible" : ""}`}>
              {fromWebsite && <ZaviMascot size={80} className="-ml-2" />}
              <h2 className="max-w-[320px] text-[20px] font-semibold leading-[28px] tracking-[-0.2px] text-[#0e0f11]">
                {headline}
              </h2>

              <ul className="flex flex-col gap-[18px]">
                {checks.map((c) => (
                  <li key={c} className="flex items-start gap-2.5">
                    <span className="mt-0.5">
                      <Tick />
                    </span>
                    <span className="text-[16px] font-medium leading-5 text-[#0e0f11]">
                      {c}
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="flex flex-col items-center gap-6">
              <p className="text-[16px] font-semibold text-[#595959]">{PROOF}</p>
              {fromWebsite ? (
                <ul className="flex flex-wrap items-center justify-center gap-x-12 gap-y-4">
                  {ONBOARDING_LOGOS.map((logo) => (
                    <li key={logo.label} className="shrink-0">
                      <img
                        src={logo.src}
                        alt={logo.label}
                        width={logo.h}
                        height={logo.h}
                        style={{ height: logo.h }}
                        className="w-auto opacity-55 grayscale"
                        draggable={false}
                      />
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="zavi-logo-marquee zavi-logo-marquee-mask relative w-full overflow-hidden">
                  <ul className="zavi-logo-marquee-track flex w-max items-center gap-12">
                    {[...LOGOS, ...LOGOS].map((logo, i) => (
                      <li key={`${logo.label}-${i}`} className="shrink-0" aria-hidden={i >= LOGOS.length}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={logo.src}
                          alt={i < LOGOS.length ? logo.label : ""}
                          width={logo.h}
                          height={logo.h}
                          style={{ height: logo.h }}
                          className="w-auto opacity-55 grayscale"
                          draggable={false}
                        />
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
