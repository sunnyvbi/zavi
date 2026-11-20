
import { HOME_FAQ } from "./homeFaq";

const SITE_URL = "https://www.zaviagent.com";
const ORG_ID = `${SITE_URL}/#organization`;

const organization = {
  "@context": "https://schema.org",
  "@type": "Organization",
  "@id": ORG_ID,
  name: "Zavi",
  alternateName: "Zavi Agent",
  legalName: "Zavi Labs",
  url: SITE_URL,
  logo: `${SITE_URL}/zavi-icon.svg`,
  description:
    "Zavi is an AI growth agent for your business. It reads your business, writes the growth plan, runs the growth work (experiments, paid acquisition, content, operations) with your approval and tells you what changed, shaped by real operating data.",
  sameAs: ["https://www.linkedin.com/company/zavi-labs/", "https://x.com/zaviagent"],
};

const website = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  "@id": `${SITE_URL}/#website`,
  name: "Zavi",
  url: SITE_URL,
  publisher: { "@id": ORG_ID },
};

const softwareApplication = (freeDailyCredits: number) => ({
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "@id": `${SITE_URL}/#software`,
  name: "Zavi",
  alternateName: "Zavi Agent",
  applicationCategory: "BusinessApplication",
  applicationSubCategory: "AI agent platform",
  operatingSystem: "Web",
  url: SITE_URL,
  publisher: { "@id": ORG_ID },
  description:
    "AI growth agent for experiments, paid acquisition, content and operations, run by the same fleet that runs Upcar, a live P2P car rental company.",
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
    description:
      `Start free with ${freeDailyCredits.toLocaleString()} credits every day, no card. Daily credits reset and do not roll over; paid plans add a monthly credit pool for bigger work. Self-serve plans starting free; Enterprise available.`,
  },
});

const faq = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "@id": `${SITE_URL}/#faq`,
  mainEntity: HOME_FAQ.map(({ q, a }) => ({
    "@type": "Question",
    name: q,
    acceptedAnswer: { "@type": "Answer", text: a },
  })),
};

export function jsonForScript(data: object): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function JsonLd({ data }: { data: object }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonForScript(data) }} />;
}

export function SiteStructuredData() {
  return (
    <>
      <JsonLd data={organization} />
      <JsonLd data={website} />
    </>
  );
}

export function HomeStructuredData({ freeDailyCredits }: { freeDailyCredits: number }) {
  return (
    <>
      <JsonLd data={softwareApplication(freeDailyCredits)} />
      <JsonLd data={faq} />
    </>
  );
}

export function FaqStructuredData({ path, items }: { path: string; items: ReadonlyArray<{ q: string; a: string }> }) {
  return (
    <JsonLd
      data={{
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "@id": `${SITE_URL}${path}#faq`,
        mainEntity: items.map(({ q, a }) => ({
          "@type": "Question",
          name: q,
          acceptedAnswer: { "@type": "Answer", text: a },
        })),
      }}
    />
  );
}

type Crumb = { name: string; path: string };

export function BreadcrumbStructuredData({ trail }: { trail: Crumb[] }) {
  const items = [{ name: "Home", path: "/" }, ...trail];
  return (
    <JsonLd
      data={{
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: items.map((c, i) => ({
          "@type": "ListItem",
          position: i + 1,
          name: c.name,
          item: `${SITE_URL}${c.path}`,
        })),
      }}
    />
  );
}

export function ItemListStructuredData({
  name,
  items,
}: {
  name: string;
  items: { name: string; description?: string; path?: string }[];
}) {
  return (
    <JsonLd
      data={{
        "@context": "https://schema.org",
        "@type": "ItemList",
        name,
        numberOfItems: items.length,
        itemListElement: items.map((it, i) => ({
          "@type": "ListItem",
          position: i + 1,
          name: it.name,
          ...(it.description ? { description: it.description } : {}),
          ...(it.path ? { url: `${SITE_URL}${it.path}` } : {}),
        })),
      }}
    />
  );
}

export function ArticleStructuredData({
  path,
  headline,
  description,
  datePublished,
  dateModified,
  author,
}: {
  path: string;
  headline: string;
  description: string;
  datePublished: string;
  dateModified: string;
  author?: { name: string; jobTitle: string };
}) {
  return (
    <JsonLd
      data={{
        "@context": "https://schema.org",
        "@type": "Article",
        "@id": `${SITE_URL}${path}#article`,
        mainEntityOfPage: `${SITE_URL}${path}`,
        headline: headline.slice(0, 110),
        description,
        datePublished,
        dateModified,
        author: author ? { "@type": "Person", name: author.name, jobTitle: author.jobTitle, worksFor: { "@id": ORG_ID } } : { "@id": ORG_ID },
        publisher: { "@id": ORG_ID },
        image: `${SITE_URL}/opengraph-image`,
      }}
    />
  );
}
