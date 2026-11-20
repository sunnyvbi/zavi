import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { jakarta } from "@/fonts";
import { resolveMarketingSession } from "@/lib/resolveCta";
import { marketingPageMetadata } from "@/lib/marketing/pageMetadata";
import { COMPARISONS, findComparison, pathForComparison } from "@/lib/marketing/comparisons";
import { BreadcrumbStructuredData, FaqStructuredData } from "@/components/marketing/StructuredData";
import { GrowthHeader } from "@/components/marketing/growth-home/GrowthHeader";
import { GrowthFooter } from "@/components/marketing/growth-home/GrowthFooter";
import { ComparePageBody } from "@/components/marketing/compare/ComparePageBody";

export function generateStaticParams() {
  return COMPARISONS.map((c) => ({ slug: c.slug }));
}

export async function generateMetadata(props: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const params = await props.params;
  const c = findComparison(params.slug);
  if (!c) return {};
  return marketingPageMetadata(pathForComparison(c.slug), c.metaTitle, c.metaDescription);
}

export default async function ComparePage(props: { params: Promise<{ slug: string }> }) {
  const params = await props.params;
  const c = findComparison(params.slug);
  if (!c) notFound();
  const { cta, email } = await resolveMarketingSession();
  const path = pathForComparison(c.slug);
  const startHref = "/start";
  return (
    <main
      className={`${jakarta.variable} min-h-screen bg-white font-[family-name:var(--font-jakarta)] text-ink selection:bg-ink selection:text-white`}
    >
      <BreadcrumbStructuredData trail={[{ name: c.h1, path }]} />
      <FaqStructuredData path={path} items={c.faq} />
      <GrowthHeader cta={cta} email={email} />
      {}
      <div aria-hidden="true" className="h-20 md:h-[100px]" />
      <ComparePageBody c={c} startHref={startHref} />
      <GrowthFooter startHref={startHref} />
    </main>
  );
}
