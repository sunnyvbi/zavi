import type { IconName } from "../../components/Icon";

export type TableCell = {
  text: string;
  sub?: string;
  href?: string;
  strong?: boolean;
  dim?: boolean;
  bad?: boolean;
  chip?: "good" | "warn" | "bad" | "muted";
  meter?: { value: number; max: number };
};

export type TableColumn = { label: string; width: number; right?: boolean };

export type RowAction = {
  id: string;
  label: string;
  busyLabel: string;
  call: { method: "POST" | "DELETE"; path: string; body?: unknown };
};

export type TableRow = {
  id: string;
  cells: TableCell[];
  detail?: { title?: string; text: string; openLabel: string; closeLabel: string };
  actions?: RowAction[];
};

export type ChannelTable = {
  id: string;
  title: string;
  icon: IconName;
  columns: TableColumn[];
  rows: TableRow[];
  empty: string;
  caption?: string | null;
};

export const col = (label: string, width = 96, right = true): TableColumn => ({ label, width, right });
export const colLeft = (label: string, width = 150): TableColumn => ({ label, width, right: false });

export const TABLE_SELECTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  seo: {
    seo_issues: "seo_issues",
    seo_speed: "seo_opportunities",
    seo_vitals_passing: "seo_vitals",
    seo_google: "seo_google",
    seo_ai: "seo_ai",
    seo_schema: "seo_pages",
  },
  geo: {
    geo_score: "geo_bands",
    geo_checks: "geo_checks",
    geo_mention_rate: "geo_mentions",
    geo_citation_rate: "geo_sources",
    geo_crawlers: "geo_crawlers",
    geo_hits: "geo_hits",
    geo_prompts: "geo_prompts",
  },
};

export const START_CLOSED: ReadonlySet<string> = new Set();

export type TablePick = {
  picking: boolean;
  claimable: ReadonlySet<string>;
  selectedKey: string | null | undefined;
  selectedTable: string | undefined;
  visible: (tableId: string) => boolean;
};

export function pickTables(
  slug: string,
  metricKeys: readonly string[],
  tableIds: readonly string[],
  picked: string | null | undefined,
): TablePick {
  const selects = TABLE_SELECTS[slug] ?? {};
  const available = new Set(tableIds);
  const claims = new Map<string, string>();
  for (const key of metricKeys) {
    const id = selects[key];
    if (id && available.has(id)) claims.set(key, id);
  }
  const picking = claims.size > 1;
  const startClosed = START_CLOSED.has(slug);
  const selectedKey: string | null | undefined = !picking
    ? undefined
    : picked === null
      ? null
      : picked && claims.has(picked)
        ? picked
        : startClosed
          ? null
          : [...claims.keys()][0];
  const selectedTable = selectedKey ? claims.get(selectedKey) : undefined;
  const claimed = new Set(claims.values());
  return {
    picking,
    claimable: picking ? new Set(claims.keys()) : new Set(),
    selectedKey,
    selectedTable,
    visible: (id) => !picking || id === selectedTable || !claimed.has(id),
  };
}

export function nextPick(slug: string, key: string, selectedKey: string | null | undefined): string | null {
  return START_CLOSED.has(slug) && key === selectedKey ? null : key;
}
