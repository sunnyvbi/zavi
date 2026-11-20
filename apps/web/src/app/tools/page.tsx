
import type { Metadata } from "next";
import { resolveMarketingSession } from "@/lib/resolveCta";
import { GrowthHeader } from "@/components/marketing/growth-home/GrowthHeader";
import { GrowthFooter } from "@/components/marketing/growth-home/GrowthFooter";
import { ToolsClient } from "@/components/tools/ToolsClient";
import { marketingPageMetadata } from "@/lib/marketing/pageMetadata";
import { BreadcrumbStructuredData, ItemListStructuredData } from "@/components/marketing/StructuredData";
import { ALL_STARTERS, TOOLS_PATH } from "@/lib/workspace/starters";

export const dynamic = "force-dynamic";

export const metadata: Metadata = marketingPageMetadata(
  TOOLS_PATH,
  "Tools | Zavi",
  "Everything Zavi can make for you: a deck, a report, a spreadsheet, a post image, a working prototype. Ask in a sentence and a finished thing comes back.",
);

export default async function ToolsPage() {
  const { cta, email } = await resolveMarketingSession();
  const signedIn = email !== null;

  return (
    <main className="min-h-screen bg-white text-[#0e0f11] selection:bg-ink selection:text-cream">
      <BreadcrumbStructuredData trail={[{ name: "Tools", path: TOOLS_PATH }]} />
      <ItemListStructuredData
        name="What Zavi can make"
        items={ALL_STARTERS.map((s) => ({ name: s.title, description: s.produces }))}
      />
      <GrowthHeader cta={cta} email={email} />
      {}
      <div aria-hidden="true" className="h-[120px] md:h-[164px]" />

      <ToolsClient signedIn={signedIn} />
      <GrowthFooter startHref={signedIn ? "/workspace" : "/start"} />
    </main>
  );
}
