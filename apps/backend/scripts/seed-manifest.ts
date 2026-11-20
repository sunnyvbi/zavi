
import "tsconfig-paths/register";
import { readFileSync, writeFileSync } from "node:fs";
import { parseEnvFile, positiveInt } from "@/services/start-card/seed/cli";
import { companyDomain, mergeManifest, pickYc, type YcCompany } from "@/services/start-card/seed/manifest";
import type { ManifestItem } from "@/services/start-card/seed/store";

const YC_URL = "https://yc-oss.github.io/api/companies/all.json";
const PH_API = "https://api.producthunt.com/v2/api/graphql";

function flag(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
}

async function fetchYc(maxTeam: number): Promise<ManifestItem[]> {
  const res = await fetch(YC_URL, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`YC list ${res.status}`);
  return pickYc((await res.json()) as YcCompany[], { maxTeam });
}

export function isPhRedirect(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "www.producthunt.com" || u.hostname === "producthunt.com") && u.pathname.startsWith("/r/");
  } catch {
    return false;
  }
}

async function resolvePhRedirect(url: string): Promise<string | null> {
  if (!isPhRedirect(url)) return companyDomain(url);
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    return companyDomain(res.headers.get("location"));
  } catch {
    return null;
  }
}

async function fetchPh(token: string, want: number, days: number): Promise<ManifestItem[]> {
  const after = new Date(Date.now() - days * 86_400_000).toISOString();
  const out: ManifestItem[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  const MAX_PAGES = 200;
  for (let page = 0; out.length < want && page < MAX_PAGES; page++) {
    const res = await fetch(PH_API, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        query: `query($after:String,$since:DateTime){posts(order:VOTES,postedAfter:$since,first:20,after:$after){edges{node{website}}pageInfo{endCursor hasNextPage}}}`,
        variables: { after: cursor, since: after },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Product Hunt API ${res.status}`);
    const body = (await res.json()) as {
      data?: { posts?: { edges: Array<{ node: { website?: string } }>; pageInfo: { endCursor: string | null; hasNextPage: boolean } } };
      errors?: unknown;
    };
    const posts = body.data?.posts;
    if (!posts) throw new Error(`Product Hunt API: ${JSON.stringify(body.errors ?? "no data").slice(0, 200)}`);
    for (const e of posts.edges) {
      const d = e.node.website ? await resolvePhRedirect(e.node.website) : null;
      if (d && !seen.has(d)) {
        seen.add(d);
        out.push({ domain: d, source: "product_hunt" });
      }
    }
    const next = posts.pageInfo.endCursor;
    if (!posts.pageInfo.hasNextPage || !next || next === cursor) break;
    cursor = next;
  }
  return out;
}

async function main() {
  const outFile = flag("out");
  if (!outFile) throw new Error("--out <file> is required");
  const limit = positiveInt(flag("limit", "1000") ?? "", "--limit");
  const maxTeam = positiveInt(flag("max-team", "200") ?? "", "--max-team");
  const phDays = positiveInt(flag("ph-days", "365") ?? "", "--ph-days");
  const envFile = flag("env");
  const token = envFile ? parseEnvFile(readFileSync(envFile, "utf8")).PRODUCT_HUNT_TOKEN : undefined;

  const yc = await fetchYc(maxTeam);
  let ph: ManifestItem[] = [];
  if (token) ph = await fetchPh(token, Math.ceil(limit / 2) + 100, phDays);
  else console.log("No PRODUCT_HUNT_TOKEN: the list is YC only.");

  const items = mergeManifest(ph.length ? [yc, ph] : [yc], limit);
  writeFileSync(outFile, JSON.stringify(items, null, 1));
  const bySource = items.reduce<Record<string, number>>((m, i) => ((m[i.source] = (m[i.source] ?? 0) + 1), m), {});
  console.log(`wrote ${items.length} sites to ${outFile}: ${JSON.stringify(bySource)} (YC candidates ${yc.length}, PH ${ph.length})`);
}

main().catch((e) => {
  console.error(`[seed-manifest] ${(e as Error).message}`);
  process.exit(1);
});
