import type { Metadata } from "next";
import { resolveMarketingSession } from "@/lib/resolveCta";
import { marketingPageMetadata } from "@/lib/marketing/pageMetadata";
import { USE_CASES, USE_CASES_PATH, pathForUseCase } from "@/lib/marketing/useCases";
import { BreadcrumbStructuredData, ItemListStructuredData } from "@/components/marketing/StructuredData";
import { GrowthHeader } from "@/components/marketing/growth-home/GrowthHeader";
import { GrowthFooter } from "@/components/marketing/growth-home/GrowthFooter";
import { UseCaseIndexBody } from "@/components/marketing/growth-home/useCases/UseCasePageBody";

export const metadata: Metadata = marketingPageMetadata(
  USE_CASES_PATH,
  "Use cases: Zavi for every kind of business",
  "How Zavi does growth work for SaaS, startups, ecommerce, marketplaces, agencies, local services, restaurants, real estate, healthcare practices, financial advisors, law firms and more.",
);

export default async function UseCasesIndexPage() {
  const { cta, email } = await resolveMarketingSession();
  const startHref = "/start";
  return (
    <>
      <BreadcrumbStructuredData trail={[{ name: "Use cases", path: USE_CASES_PATH }]} />
      <ItemListStructuredData
        name="Zavi use cases"
        items={USE_CASES.map((u) => ({ name: u.name, description: u.outcome, path: pathForUseCase(u.slug) }))}
      />
      <GrowthHeader cta={cta} email={email} />
      <main className="min-h-screen shrink-0 bg-white text-[#0e0f11]">
        <UseCaseIndexBody startHref={startHref} />
      </main>
      <GrowthFooter startHref={startHref} />
    </>
  );
}
