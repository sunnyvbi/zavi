
import { Lock } from "lucide-react";

const HEADING = "Download the app";

const PLAY_URL = "https://play.google.com/store/apps/details?id=com.zaviagent.app";

const APP_STORE_URL = "https://apps.apple.com/app/id6809340210";

const BADGES: { src: string; alt: string; width: number; href: string; ios?: true }[] = [
  {
    src: "/badges/app-store-black.png",
    alt: "Download on the App Store",
    width: 273,
    href: APP_STORE_URL,
    ios: true,
  },
  { src: "/badges/google-play-black.png", alt: "Get it on Google Play", width: 274, href: PLAY_URL },
];

const BADGE_CLASS = "inline-flex overflow-hidden rounded-[7px]";

export function GrowthDownloadApp({ iosLive = false }: { iosLive?: boolean }) {
  return (
    <section className="w-full bg-white px-4 pb-14 pt-6 sm:px-6 sm:py-16 lg:py-20">
      <div className="mx-auto max-w-[1215px]">
        <div aria-hidden="true" className="hidden pt-[calc(37.72%-278px)] lg:block" />

        <div className="relative rounded-blockLg bg-[#f9f9f9] lg:h-[278px] lg:rounded-[56px]">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]"
          >
            <img
              src="/download-app-bg.webp"
              alt=""
              className="absolute inset-0 h-full w-full select-none object-cover object-[75%_50%] lg:object-center"
            />
            <img
              src="/download-app-glow.svg"
              alt=""
              width={1431}
              height={1377}
              className="absolute left-[-699.9px] top-[-899.9px] max-w-none select-none"
            />
          </div>

          <div className="relative flex flex-col items-center px-6 pt-12 text-center lg:items-start lg:pl-[102px] lg:pt-[66px] lg:text-left">
            <h2 className="text-[32px] font-bold leading-[1.5] text-[#0e0f11] sm:text-[40px]">
              {HEADING}
            </h2>

            <div className="mt-6 flex items-center gap-[10px] lg:mt-[58px]">
              {BADGES.map((badge) =>
                badge.ios && !iosLive ? (
                  <span
                    key={badge.src}
                    aria-label="App Store, coming soon"
                    title="Coming soon to the App Store"
                    className="relative inline-flex cursor-not-allowed"
                  >
                    <span className={BADGE_CLASS}>
                      <img
                        src={badge.src}
                        alt=""
                        width={badge.width}
                        height={80}
                        className="h-[36px] w-auto opacity-60"
                      />
                    </span>
                    {}
                    <span
                      aria-hidden="true"
                      className="absolute -right-1.5 -top-1.5 flex h-[18px] w-[18px] items-center justify-center rounded-full border border-[#e5e5e5] bg-white text-[#0e0f11] shadow-sm"
                    >
                      <Lock className="h-2.5 w-2.5" strokeWidth={2.5} />
                    </span>
                  </span>
                ) : (
                  <a
                    key={badge.src}
                    href={badge.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`${BADGE_CLASS} transition-opacity duration-200 hover:opacity-85 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0e0f11]`}
                  >
                    <img
                      src={badge.src}
                      alt={badge.alt}
                      width={badge.width}
                      height={80}
                      className="h-[36px] w-auto"
                    />
                  </a>
                ),
              )}
            </div>
          </div>

          <div className="relative mx-auto mt-10 w-[88%] max-w-[420px] lg:absolute lg:bottom-0 lg:left-[55.18%] lg:mt-0 lg:w-[39.88%] lg:max-w-none">
            <img
              src="/zavi-app-mockup.png"
              alt="The Zavi app on two phones: Zavi finds why visitors aren't signing up, then shows daily signups at 2.1x after the fix."
              width={2436}
              height={2304}
              className="block h-auto w-full"
            />
          </div>
        </div>
      </div>
    </section>
  );
}
