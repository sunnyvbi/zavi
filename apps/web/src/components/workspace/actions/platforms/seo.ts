
import { Bot, Braces, FileSearch, Gauge, SearchCheck, Timer } from "lucide-react";
import type { MetricDisplay, PlatformSpec } from "./_shared";
import { seoSiteName } from "../../seo/extraTables";

const SEO_METRICS: Record<string, MetricDisplay> = {
  seo_issues: { label: "Issues", icon: FileSearch },
  seo_speed: { label: "Speed (lab)", icon: Gauge, selects: "seo_opportunities" },
  seo_vitals_passing: { label: "Real visitors", icon: Timer, selects: "seo_vitals" },
  seo_google: { label: "Google SEO check", icon: SearchCheck, selects: "seo_google" },
  seo_ai: { label: "AI readiness", icon: Bot, selects: "seo_ai" },
  seo_schema: { label: "Structured data", icon: Braces, selects: "seo_pages" },
};

export const seo: PlatformSpec = {
  name: "SEO",
  kpiFallback: "seo",
  metricDisplay: SEO_METRICS,
  metricLayout: { variant: "score", startClosed: true },
  postingSettings: { accountFromPayload: seoSiteName, connectionName: "Google Search Console", connectionLogo: "/logos/google-search-console-icon.svg" },
  extras: ["seo_tables"],
  maxWidth: "max-w-[1180px]",

  execCopy: {
    working: "Zavi's engineer is opening the pull request. This can take 10 to 20 minutes.",
    done: "Pull request opened. Review and merge it on GitHub.",
    failedTitle: "No pull request was opened.",
    failedHint: "Nothing in your repository changed. Press Try again.",
    waiting: "Zavi's engineer prepared the pull request. It is waiting for your approval lower on this page; approve it there and it opens.",
    partialTitle: "Zavi will not open another pull request from this card.",
    temporaryHint: "Press Try again to have Zavi prepare it again.",
  },
};
