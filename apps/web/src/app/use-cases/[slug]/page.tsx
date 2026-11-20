import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { resolveMarketingSession } from "@/lib/resolveCta";
import { marketingPageMetadata } from "@/lib/marketing/pageMetadata";
import { USE_CASES, USE_CASES_PATH, findUseCase, pathForUseCase } from "@/lib/marketing/useCases";
import { BreadcrumbStructuredData } from "@/components/marketing/StructuredData";
import { GrowthHeader } from "@/components/marketing/growth-home/GrowthHeader";
import { GrowthFooter } from "@/components/marketing/growth-home/GrowthFooter";
import { UseCasePageBody } from "@/components/marketing/growth-home/useCases/UseCasePageBody";

export function generateStaticParams() {
  return USE_CASES.map((u) => ({ slug: u.slug }));
}

export async function generateMetadata(props: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const params = await props.params;
  const u = findUseCase(params.slug);
  if (!u) return {};
  return marketingPageMetadata(pathForUseCase(u.slug), u.metaTitle, u.metaDescription);
}

export default async function UseCasePage(props: { params: Promise<{ slug: string }> }) {
  const params = await props.params;
  const u = findUseCase(params.slug);
  if (!u) notFound();
  const { cta, email } = await resolveMarketingSession();
  const startHref = "/start";
  return (
    <>
      <BreadcrumbStructuredData
        trail={[
          { name: "Use cases", path: USE_CASES_PATH },
          { name: u.name, path: pathForUseCase(u.slug) },
        ]}
      />
      <GrowthHeader cta={cta} email={email} />
      <main className="min-h-screen shrink-0 bg-white text-[#0e0f11]">
        <UseCasePageBody u={u} startHref={startHref} />
      </main>
      <GrowthFooter startHref={startHref} />
    </>
  );
}
