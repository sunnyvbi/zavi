
export type BlogFaq = { q: string; a: string };
export type BlogSource = { label: string; url: string };

export type BlogPost = {
  slug: string;
  title: string;
  description: string;
  h1: string;
  datePublished: string;
  dateModified: string;
  reviewedAt: string;
  answer: string;
  body: string;
  faq: BlogFaq[];
  sources: BlogSource[];
  cta: { label: string; href: string; text: string };
  query: string;
};
