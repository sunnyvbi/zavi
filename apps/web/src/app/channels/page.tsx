import type { Metadata } from "next";
import Link from "next/link";
import { resolveMarketingSession } from "@/lib/resolveCta";
import { GrowthHeader } from "@/components/marketing/growth-home/GrowthHeader";
import { GrowthFooter } from "@/components/marketing/growth-home/GrowthFooter";
import { GrowthFinalCta } from "@/components/marketing/growth-home/GrowthFinalCta";
import { CHANNEL_PAGES, CHANNELS_PATH, ChannelGlyph } from "@/components/marketing/growth-home/channels/channelPages";
import { BreadcrumbStructuredData, ItemListStructuredData } from "@/components/marketing/StructuredData";
import { marketingPageMetadata } from "@/lib/marketing/pageMetadata";
import { EYEBROW, FOCUS, H2 } from "@/components/marketing/growth-home/growthUi";

export const dynamic = "force-dynamic";

export const metadata: Metadata = marketingPageMetadata(
  CHANNELS_PATH,
  "Channels | Zavi",
  "Every growth channel Zavi runs, one page each: what the agent reads, what it proposes, and what waits for your approval.",
);

export default async function ChannelsIndexPage() {
  const { cta, email } = await resolveMarketingSession();
  const startHref = "/start";
  return (
    <main className="min-h-screen bg-white text-[#0e0f11]">
      <BreadcrumbStructuredData trail={[{ name: "Channels", path: CHANNELS_PATH }]} />
      <ItemListStructuredData
        name="Zavi growth channels"
        items={CHANNEL_PAGES.map((c) => ({ name: c.agent, description: c.desc, path: `${CHANNELS_PATH}/${c.id}` }))}
      />
      <GrowthHeader cta={cta} email={email} />

      <section className="mx-auto max-w-[1120px] px-4 pb-16 pt-36 sm:px-6 sm:pt-44 lg:pb-24">
        <p className={EYEBROW}>Channels</p>
        <h1 className={`${H2} mt-3 max-w-[760px]`}>One agent, every channel you run.</h1>
        <p className="mt-5 max-w-[680px] text-[16px] leading-[1.625] text-[#595959]">
          Zavi reads each channel you connect, works out what is quietly costing you money, and
          proposes the fix. Changes wait for your yes, or you set a spend cap the ad agents stay
          inside. Pick a channel to see what its agent does.
        </p>

        <ul className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {CHANNEL_PAGES.map((c) => (
            <li key={c.id}>
              <Link
                href={`/channels/${c.id}`}
                prefetch={false}
                className={`flex h-full flex-col rounded-block border border-black/[0.07] bg-white p-7 transition-colors duration-200 hover:border-black/20 ${FOCUS} focus-visible:rounded-block`}
              >
                <span className="flex size-10 items-center justify-center rounded-[12px] bg-[#f1f1f3]">
                  <ChannelGlyph channel={c} />
                </span>
                <span className="mt-4 text-[20px] font-bold leading-[1.375] tracking-[-0.01em]">
                  {c.agent}
                </span>
                <span className="mt-2 text-[14px] leading-[1.625] text-[#595959]">{c.desc}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <GrowthFinalCta startHref={startHref} />
      <GrowthFooter startHref={startHref} />
    </main>
  );
}
