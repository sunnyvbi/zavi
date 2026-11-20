import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { jakarta } from "@/fonts";
import { resolveMarketingSession } from "@/lib/resolveCta";
import { articlePageMetadata } from "@/lib/marketing/pageMetadata";
import { BLOG_AUTHOR, BLOG_PATH, BLOG_POSTS, findPost, pathForPost } from "@/lib/marketing/blog";
import { ArticleStructuredData, BreadcrumbStructuredData, FaqStructuredData } from "@/components/marketing/StructuredData";
import { GrowthHeader } from "@/components/marketing/growth-home/GrowthHeader";
import { GrowthFooter } from "@/components/marketing/growth-home/GrowthFooter";
import { BlogMarkdown } from "@/components/marketing/blog/BlogMarkdown";
import { fmtPostDate } from "../format";

export function generateStaticParams() {
  return BLOG_POSTS.map((p) => ({ slug: p.slug }));
}

const iso = (day: string) => `${day}T12:00:00.000Z`;

export async function generateMetadata(props: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const params = await props.params;
  const p = findPost(params.slug);
  if (!p) notFound();
  return articlePageMetadata(pathForPost(p.slug), p.title, p.description, {
    publishedTime: iso(p.datePublished),
    modifiedTime: iso(p.dateModified),
    author: BLOG_AUTHOR.name,
  });
}

export default async function BlogPostPage(props: { params: Promise<{ slug: string }> }) {
  const params = await props.params;
  const p = findPost(params.slug);
  if (!p) notFound();
  const { cta, email } = await resolveMarketingSession();
  const startHref = email !== null ? "/workspace" : "/start";
  const path = pathForPost(p.slug);
  const others = BLOG_POSTS.filter((o) => o.slug !== p.slug).slice(0, 3);
  return (
    <main className={`${jakarta.variable} min-h-screen bg-white font-[family-name:var(--font-jakarta)] text-ink`}>
      <BreadcrumbStructuredData trail={[{ name: "Blog", path: BLOG_PATH }, { name: p.h1, path }]} />
      <ArticleStructuredData
        path={path}
        headline={p.h1}
        description={p.description}
        datePublished={iso(p.datePublished)}
        dateModified={iso(p.dateModified)}
        author={{ name: BLOG_AUTHOR.name, jobTitle: BLOG_AUTHOR.role }}
      />
      <FaqStructuredData path={path} items={p.faq} />
      <GrowthHeader cta={cta} email={email} />
      <div aria-hidden="true" className="h-20 md:h-[100px]" />
      <article className="mx-auto max-w-[760px] px-4 pt-6 pb-16 sm:px-6">
        <nav aria-label="Breadcrumb" className="font-mono text-[12px] text-[#6b7076]">
          <a href={BLOG_PATH} className="underline underline-offset-4">
            Blog
          </a>
        </nav>
        <h1 className="mt-4 text-[30px] leading-tight font-bold tracking-tight [overflow-wrap:anywhere] sm:text-[40px]">{p.h1}</h1>
        <p className="mt-4 text-[13px] text-[#6b7076]">
          By {BLOG_AUTHOR.name}, {BLOG_AUTHOR.role} · Published {fmtPostDate(p.datePublished)}
          {p.dateModified !== p.datePublished ? ` · Updated ${fmtPostDate(p.dateModified)}` : ""} · Facts checked {fmtPostDate(p.reviewedAt)}
        </p>
        <p className="mt-6 rounded-xl border border-[#0e0f11]/12 bg-[#f7f7f5] p-4 text-[17px] leading-relaxed font-semibold sm:p-5">{p.answer}</p>
        <div className="mt-8">
          <BlogMarkdown>{p.body}</BlogMarkdown>
        </div>

        {p.sources.length > 0 && (
          <section className="mt-10">
            <h2 className="text-[20px] font-bold tracking-tight">Sources</h2>
            <ul className="mt-3 list-disc pl-5 text-[14px] text-[#3a3d42]">
              {p.sources.map((s) => (
                <li key={s.url} className="mt-1 [overflow-wrap:anywhere]">
                  <a href={s.url} className="underline underline-offset-4" {...(s.url.startsWith("http") ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
                    {s.label}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="mt-10">
          <h2 className="text-[20px] font-bold tracking-tight">Questions people also ask</h2>
          <dl className="mt-3 border-b border-[#0e0f11]/12">
            {p.faq.map((f) => (
              <div key={f.q} className="border-t border-[#0e0f11]/12 py-4">
                <dt className="text-[16px] font-semibold">{f.q}</dt>
                <dd className="mt-1.5 text-[15px] text-[#3a3d42]">{f.a}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="mt-10 rounded-2xl bg-[#07090d] p-6 text-white sm:p-8">
          <p className="text-[16px] text-white/80">{p.cta.text}</p>
          <a href={p.cta.href} className="mt-4 inline-flex min-h-12 items-center rounded-full bg-[#027bff] px-6 text-[16px] font-semibold text-white">
            {p.cta.label} →
          </a>
        </section>

        {others.length > 0 && (
          <section className="mt-12">
            <h2 className="text-[20px] font-bold tracking-tight">More from the blog</h2>
            <ul className="mt-3">
              {others.map((o) => (
                <li key={o.slug} className="mt-2">
                  <a href={pathForPost(o.slug)} className="text-[15px] font-semibold underline underline-offset-4">
                    {o.h1}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}
      </article>
      <GrowthFooter startHref={startHref} />
    </main>
  );
}
