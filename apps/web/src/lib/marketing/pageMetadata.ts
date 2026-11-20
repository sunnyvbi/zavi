import type { Metadata } from "next";
import { WWW_ORIGIN } from "@/lib/marketing/retiredSubdomains";

const SHARE_IMAGE = { url: "/opengraph-image", width: 1200, height: 630, alt: "Zavi: AI Growth Agent For Your Business" };

export function marketingPageMetadata(
  path: string,
  title: string,
  description: string,
  image: { url: string; alt: string } = SHARE_IMAGE,
): Metadata {
  const url = `${WWW_ORIGIN}${path}`;
  const card = { width: 1200, height: 630, ...image };
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { title, description, url, siteName: "Zavi", type: "website", images: [card] },
    twitter: { card: "summary_large_image", title, description, images: [card.url] },
  };
}

export function articlePageMetadata(
  path: string,
  title: string,
  description: string,
  a: { publishedTime: string; modifiedTime: string; author: string },
): Metadata {
  const base = marketingPageMetadata(path, title, description);
  return {
    ...base,
    authors: [{ name: a.author }],
    openGraph: {
      title,
      description,
      url: `${WWW_ORIGIN}${path}`,
      siteName: "Zavi",
      type: "article",
      publishedTime: a.publishedTime,
      modifiedTime: a.modifiedTime,
      authors: [a.author],
      images: [SHARE_IMAGE],
    },
  };
}
