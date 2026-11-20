
import type { VisibilityMetrics } from "./metrics";

type Directory = { host: string; name: string; way_in_url: string };

export const LISTING_DIRECTORIES: readonly Directory[] = [
  { host: "g2.com", name: "G2", way_in_url: "https://sell.g2.com/create-free-profile" },
  { host: "producthunt.com", name: "Product Hunt", way_in_url: "https://www.producthunt.com/launch" },
  { host: "trustpilot.com", name: "Trustpilot", way_in_url: "https://business.trustpilot.com/signup" },
  { host: "yelp.com", name: "Yelp", way_in_url: "https://biz.yelp.com/" },
  { host: "joe.coffee", name: "Joe Coffee", way_in_url: "https://joe.coffee/claim" },
];

const COMMUNITY_HOSTS = ["reddit.com", "redd.it", "quora.com", "news.ycombinator.com", "indiehackers.com"];
const APP_STORE_HOSTS = ["apps.apple.com", "itunes.apple.com", "play.google.com"];

const MAX_CHECKED = 8;
const MAX_PROMPTS = 2;

const hostMatches = (domain: string, host: string): boolean => {
  const d = domain.toLowerCase().replace(/^www\./, "");
  return d === host || d.endsWith(`.${host}`);
};

export type ListingCheckReason = "another_directory" | "community" | "app_store" | "no_known_way_in";

export type ListingTarget = {
  domain: string;
  name: string;
  responses: number;
  way_in_url: string;
  how_to: string[];
  prompts: string[];
};

export type ListingTargets = {
  listing_target: ListingTarget | null;
  listing_checked: { domain: string; reason: ListingCheckReason }[];
  listing_checked_omitted: number;
};

export function listingTargetsOf(m: VisibilityMetrics | null): ListingTargets {
  const none: ListingTargets = { listing_target: null, listing_checked: [], listing_checked_omitted: 0 };
  if (!m) return none;

  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
  const rivalNames = new Set(m.share_of_voice.rivals.map((r) => norm(r.name.replace(/^www\./i, ""))));
  const isRival = (dir: Directory) =>
    [dir.name, dir.host, dir.host.split(".")[0]].some((x) => rivalNames.has(norm(x)));

  const cited = m.source_mix.domains.filter((d) => d.kind === "other");

  const byDir = new Map<Directory, { responses: number; domain: string }>();
  for (const d of cited) {
    const dir = LISTING_DIRECTORIES.find((x) => hostMatches(d.domain, x.host));
    if (!dir || isRival(dir)) continue;
    const prev = byDir.get(dir);
    byDir.set(dir, {
      responses: (prev?.responses ?? 0) + d.responses,
      domain: prev && prev.responses >= d.responses ? prev.domain : d.domain,
    });
  }
  const ranked = [...byDir].sort((a, b) => b[1].responses - a[1].responses || a[0].host.localeCompare(b[0].host));
  const chosen = ranked[0] ?? null;

  let target: ListingTarget | null = null;
  if (chosen) {
    const [dir, hit] = chosen;
    target = {
      domain: hit.domain,
      name: dir.name,
      responses: hit.responses,
      way_in_url: dir.way_in_url,
      how_to: [
        `Open ${dir.way_in_url} and search ${dir.name} for the company. If a profile is there, claim or update it; if not, create one.`,
        "Paste the listing copy below into the description and submit it.",
      ],
      prompts: m.prompt_grid.rows
        .filter((r) => r.rival_only_responses > 0 && r.cited_domains.some((c) => hostMatches(c.domain, dir.host)))
        .sort((a, b) => b.rival_only_responses - a.rival_only_responses)
        .slice(0, MAX_PROMPTS)
        .map((r) => r.prompt_text),
    };
  }

  const checked: ListingTargets["listing_checked"] = [];
  for (const d of [...cited].sort((a, b) => b.responses - a.responses || a.domain.localeCompare(b.domain))) {
    const dir = LISTING_DIRECTORIES.find((x) => hostMatches(d.domain, x.host));
    if (dir && chosen && dir === chosen[0]) continue;
    const reason: ListingCheckReason = dir
      ? "another_directory"
      : COMMUNITY_HOSTS.some((h) => hostMatches(d.domain, h))
        ? "community"
        : APP_STORE_HOSTS.some((h) => hostMatches(d.domain, h))
          ? "app_store"
          : "no_known_way_in";
    checked.push({ domain: d.domain, reason });
  }
  return {
    listing_target: target,
    listing_checked: checked.slice(0, MAX_CHECKED),
    listing_checked_omitted: Math.max(0, checked.length - MAX_CHECKED),
  };
}
