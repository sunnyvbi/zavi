

export type ExtractionRow = {
  name: string;
  level: "campaign" | "adset" | "ad" | "unknown";
  status?: string | null;
  spend?: number | null;
  impressions?: number | null;
  clicks?: number | null;
  cpa?: number | null;
  roas?: number | null;
  currency?: string | null;
};

export type WireExtraction = {
  rows: ExtractionRow[];
  date_preset: string | null;
  account_name: string | null;
  truncated: boolean;
  row_count_total: number;
};

export type AdapterExtraction = {
  adapter_id: string;
  schema_version: number;
  extraction: WireExtraction;
};

export type AdapterLocation = {
  hostname: string;
  pathname: string;
};

export type PageAdapter = {
  readonly id: string;
  readonly schema_version: number;
  matches(location: AdapterLocation): boolean;
  extract(doc: Document): WireExtraction | null;
};
