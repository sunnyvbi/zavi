import type { Metadata } from "next";
import { jakarta } from "@/fonts";
import { resolveMarketingSession } from "@/lib/resolveCta";
import { marketingPageMetadata } from "@/lib/marketing/pageMetadata";
import { BLOG_PATH, BLOG_POSTS, pathForPost } from "@/lib/marketing/blog";
import { BreadcrumbStructuredData, ItemListStructuredData } from "@/components/marketing/StructuredData";
import { GrowthHeader } from "@/components/marketing/growth-home/GrowthHeader";
import { GrowthFooter } from "@/components/marketing/growth-home/GrowthFooter";
import { fmtPostDate } from "./format";

export const metadata: Metadata = marketingPageMetadata(
  BLOG_PATH,
  "Blog · Zavi: AI Growth Agent For Your Business",
  "Straight answers to the growth questions founders search for: getting found on Google and in ChatGPT, first customers, and what an AI growth agent should and should not do.",
);

export default async function BlogIndexPage() {
  const { cta, email } = await resolveMarketingSession();
  const startHref = email !== null ? "/workspace" : "/start";
  return (
    <main className={`${jakarta.variable} min-h-screen bg-white font-[family-name:var(--font-jakarta)] text-ink`}>
      <BreadcrumbStructuredData trail={[{ name: "Blog", path: BLOG_PATH }]} />
      <ItemListStructuredData name="Zavi blog" items={BLOG_POSTS.map((p) => ({ name: p.h1, description: p.description, path: pathForPost(p.slug) }))} />
      <GrowthHeader cta={cta} email={email} />
      <div aria-hidden="true" className="h-20 md:h-[100px]" />
      <section className="mx-auto max-w-[860px] px-4 pt-6 pb-16 sm:px-6">
        <h1 className="text-[34px] font-bold tracking-tight sm:text-[44px]">Blog</h1>
        <p className="mt-3 max-w-[640px] text-[16px] text-[#3a3d42]">
          Straight answers to the growth questions founders search for. Each one starts with the answer.
        </p>
        <ul className="mt-10 border-b border-[#0e0f11]/12">
          {BLOG_POSTS.map((p) => (
            <li key={p.slug} className="border-t border-[#0e0f11]/12 py-6">
              <a href={pathForPost(p.slug)} className="group block">
                <p className="font-mono text-[12px] text-[#6b7076]">{fmtPostDate(p.datePublished)}</p>
                <h2 className="mt-1.5 text-[20px] leading-snug font-bold tracking-tight [overflow-wrap:anywhere] group-hover:underline sm:text-[22px]">{p.h1}</h2>
                <p className="mt-2 text-[15px] text-[#3a3d42]">{p.description}</p>
              </a>
            </li>
          ))}
        </ul>
      </section>
      <GrowthFooter startHref={startHref} />
    </main>
  );
}
