import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { resolveMarketingSession } from "@/lib/resolveCta";
import { GrowthHeader } from "@/components/marketing/growth-home/GrowthHeader";
import { GrowthFooter } from "@/components/marketing/growth-home/GrowthFooter";
import { ChannelPageBody } from "@/components/marketing/growth-home/channels/ChannelPageBody";
import { CHANNEL_PAGES, CHANNELS_PATH, channelBySlug } from "@/components/marketing/growth-home/channels/channelPages";
import { BreadcrumbStructuredData } from "@/components/marketing/StructuredData";
import { marketingPageMetadata } from "@/lib/marketing/pageMetadata";

export function generateStaticParams() {
  return CHANNEL_PAGES.map((c) => ({ slug: c.id }));
}

export async function generateMetadata(props: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const params = await props.params;
  const c = channelBySlug(params.slug);
  if (!c) return {};
  return marketingPageMetadata(`/channels/${c.id}`, `${c.agent} | Zavi`, c.desc);
}

export default async function ChannelPage(props: { params: Promise<{ slug: string }> }) {
  const params = await props.params;
  const c = channelBySlug(params.slug);
  if (!c) notFound();
  const { cta, email } = await resolveMarketingSession();
  const startHref = "/start";
  return (
    <>
      <BreadcrumbStructuredData
        trail={[
          { name: "Channels", path: CHANNELS_PATH },
          { name: c.agent, path: `${CHANNELS_PATH}/${c.id}` },
        ]}
      />
      <GrowthHeader cta={cta} email={email} />
      <main className="min-h-screen shrink-0 bg-white text-[#0e0f11]">
        <ChannelPageBody c={c} startHref={startHref} />
      </main>
      <GrowthFooter startHref={startHref} />
    </>
  );
}
