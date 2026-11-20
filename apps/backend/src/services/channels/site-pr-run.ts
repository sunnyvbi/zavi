
export const SITE_PR_CLASSES: ReadonlySet<string> = new Set(["seo.create_pr.v1", "geo.create_pr.v1"]);

export function sitePrClassOfRun(run: { enqueued_by?: string | null; payload?: unknown }): string | null {
  if (run.enqueued_by != null) return null;
  const cls = (run.payload as { site_pr_card?: { exec_class?: unknown } } | null | undefined)?.site_pr_card?.exec_class;
  return typeof cls === "string" && SITE_PR_CLASSES.has(cls) ? cls : null;
}

export function channelOfSitePrClass(cls: string | null | undefined): string | null {
  return typeof cls === "string" && SITE_PR_CLASSES.has(cls) ? cls.split(".")[0] : null;
}

export function sitePrClassForChannel(channelSlug: string): string | null {
  const cls = `${channelSlug}.create_pr.v1`;
  return SITE_PR_CLASSES.has(cls) ? cls : null;
}

export function listingChannelOfRun(run: {
  channel_slug?: string | null;
  enqueued_by?: string | null;
  site_pr_class?: string | null;
}): string | null {
  if (run.channel_slug) return run.channel_slug;
  if (run.enqueued_by != null) return null;
  return channelOfSitePrClass(run.site_pr_class);
}
