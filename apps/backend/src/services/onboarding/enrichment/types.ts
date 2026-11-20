
export type DomainPage = { url: string; title: string; text_excerpt: string; site_name?: string };

export type AppListing = {
  store: "ios" | "android";
  url: string;
  name: string | null;
  version: string | null;
  last_updated: string | null;
  rating: number | null;
  ratings_count: number | null;
  support_url: string | null;
};

export type EnrichmentPayload = {
  domain_pages: DomainPage[];
  app_listings: AppListing[];
  research_pages?: DomainPage[];
};
