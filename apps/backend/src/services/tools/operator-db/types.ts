
export type OperatorDbType = "postgres" | "mongodb" | "mysql" | "dynamodb";

export type RawColumn = { name: string; type: string; nullable: boolean;  json_keys?: string[]; json_sampled?: "full" | "partial" | "none"; json_map_like?: boolean };

export type RawTable = {
  name: string;
  columns: RawColumn[];
  rowEstimate: number | null;
  view_of?: string;
  removed_fields?: string[];
  partitioned?: boolean;
  partitions?: string[];
  parents?: string[];
};

export type RawIntrospection = {
  dialect: OperatorDbType;
  tables: RawTable[];
  skippedUnsafeNames: number;
  namesSeenTotal: number;
  deadlineHit: boolean;
  listingTruncated: boolean;
};

export type DiscoveryCoverage = {
  tables_total: number;
  tables_indexed: number;
  skipped_unsafe_names: number;
  deadline_hit: boolean;
  listing_truncated: boolean;
};

export type CatalogColumn = { name: string; type: string; nullable: boolean;  json_keys?: string[]; json_sampled?: "full" | "partial" | "none"; json_map_like?: boolean };

export type CatalogTable = {
  name: string;
  columns: CatalogColumn[];
  rowEstimate: number | null;
  view_of?: string;
  removed_fields?: string[];
  partitioned?: boolean;
  partitions?: string[];
  parents?: string[];
};

export type OperatorDbCatalog = { tables: CatalogTable[] };

export type EntityHints = {
  users?: { table: string; id_field: string };
  listings?: { table: string; id_field: string; geo_field?: string };
  transactions?: { table: string };
  bookings?: {
    table: string;
    geo_field?: string;
    category_field?: string;
    created_at_field?: string;
    gmv_proxy_field?: string;
    listing_ref_field?: string;
  };
  cancellations?: {
    table: string;
    status_field?: string;
    reason_field?: string;
    created_at_field?: string;
  };
  _confidence?: Record<string, number>;
};

export type OperatorDbConfig = {
  type: OperatorDbType;
  connection_secret_key: string;
  schema_map: SchemaMap;
};

export type SchemaMap = {
  users: TableMap;
  listings?: TableMap;
  transactions?: TableMap;
  bookings?: BookingsTableMap;
  search_events?: EventTableMap;
  view_events?: EventTableMap;
  contact_events?: EventTableMap;
};

export type TableMap = {
  table: string;
  id_field: string;
  status_field?: string;
  reason_field?: string;
  created_at_field?: string;
};

export type BookingsTableMap = TableMap & {
  geo_field: string;
  category_field: string;
  created_at_field: string;
  gmv_proxy_field?: string;
  listing_ref_field?: string;
};

export type EventTableMap = TableMap & {
  geo_field: string;
  created_at_field: string;
  listing_ref_field?: string;
  category_field?: string;
};

export type OperatorDbResult<T = unknown> = {
  ok: true;
  rows_affected?: number;
  data?: T;
};

export type GeoCategoryWeekRow = {
  city: string;
  category: string;
  week_start: string;
  bookings_n: number;
  gmv_proxy_n: number;
};

export type ActiveSupplyWeekRow = {
  city: string;
  category: string;
  week_start: string;
  active_listings_n: number;
  total_listings_n: number;
  avg_days_since_last_booking: number | null;
};

export type FunnelWeekRow = {
  city: string;
  category: string;
  week_start: string;
  search_n: number | null;
  view_n: number | null;
  contact_n: number | null;
  book_n: number;
};

export type VerifiedBookingByCampaignRow = {
  utm_campaign: string;
  utm_source: string | null;
  verified_bookings: number;
  net_gmv: number;
};

export type VerifiedNotAvailableReason =
  | "not_available"
  | "order_map_unconfirmed"
  | "no_customer_table"
  | "no_utm_field"
  | "no_finished_orders"
  | "read_failed";

export type VerifiedBookingsByCampaignResult = {
  available: boolean;
  reason?: VerifiedNotAvailableReason;
  window_days: number;
  total_verified: number;
  matched_verified: number;
  rows: VerifiedBookingByCampaignRow[];
  truncated?: boolean;
  unreadable_revenue_orders?: number;
  utm_fields?: { campaign: string; source: string | null };
};

export type VerifiedOrderMap = {
  booking_source: string;
  status_field: string;
  terminal_statuses: string[];
  completed_at_field: string;
  customer_ref_field: string;
  revenue_field: string | null;
  refund_field: string | null;
  refund_basis: "none" | "booking_created_net" | "refund_event_day";
  amount_unit: "dollars" | "cents";
};

export type VerifiedBookingsFilter = {
  window_days: number;
  order_map?: VerifiedOrderMap | null;
  user_columns?: Array<{ name: string; type: string }>;
};

export type NewUsersInWindowResult = {
  available: boolean;
  reason?: "not_available";
  detail?: string;
  window_days: number;
  count: number;
};

export type NewUsersFilter = {
  window_days: number;
};

export type NewBookingsInWindowResult = {
  available: boolean;
  reason?: "not_available";
  detail?: string;
  window_days: number;
  count: number;
};

export type NewBookingsFilter = {
  window_days: number;
};

export type AggregateResult<R> = {
  rows: R[];
  truncated: boolean;
  total_segments_seen: number;
};

export type AggregateFilter = {
  lookback_weeks: number;
  focus_city?: string;
  focus_category?: string;
  top_n: number;
};

export type GenericReadOptions = {
  projection?: Record<string, number>;
  sort?: Record<string, number>;
  limit?: number;
  skip?: number;
  secretFieldExclusions?: string[];
};

export type GenericReadResult = {
  collection: string;
  row_count: number;
  truncated: boolean;
  rows: Record<string, unknown>[];
  masked?: "strings";
};

export type CountRangeFilter = { since: string; until: string; match?: Record<string, string | number | boolean> };

export type CountInRangeResult = {
  available: boolean;
  reason?: "not_available";
  detail?: string;
  since: string;
  until: string;
  count: number;
};

export type RecordReadOptions = { secretFieldExclusions?: string[] };

export type OperatorDbDriver = {
  query_user(userId: string, cfg: SchemaMap, opts?: RecordReadOptions): Promise<OperatorDbResult<Record<string, unknown> | null>>;
  query_listing(listingId: string, cfg: SchemaMap, opts?: RecordReadOptions): Promise<OperatorDbResult<Record<string, unknown> | null>>;
  query_recent_transactions(
    userId: string,
    sinceUnix: number,
    cfg: SchemaMap,
    opts?: RecordReadOptions,
  ): Promise<OperatorDbResult<Record<string, unknown>[]>>;

  query_bookings_by_geo_category(
    filter: AggregateFilter,
    cfg: SchemaMap,
  ): Promise<OperatorDbResult<AggregateResult<GeoCategoryWeekRow>>>;
  query_active_supply_by_geo_category(
    filter: AggregateFilter,
    cfg: SchemaMap,
  ): Promise<OperatorDbResult<AggregateResult<ActiveSupplyWeekRow>>>;
  query_funnel_by_geo_category(
    filter: AggregateFilter,
    cfg: SchemaMap,
  ): Promise<OperatorDbResult<AggregateResult<FunnelWeekRow>>>;

  query_verified_bookings_by_campaign(
    filter: VerifiedBookingsFilter,
    cfg: SchemaMap,
  ): Promise<OperatorDbResult<VerifiedBookingsByCampaignResult>>;

  query_new_users_in_window(
    filter: NewUsersFilter,
    cfg: SchemaMap,
  ): Promise<OperatorDbResult<NewUsersInWindowResult>>;

  query_new_bookings_in_window(
    filter: NewBookingsFilter,
    cfg: SchemaMap,
  ): Promise<OperatorDbResult<NewBookingsInWindowResult>>;

  query_new_users_in_range?(
    filter: CountRangeFilter,
    cfg: SchemaMap,
  ): Promise<OperatorDbResult<CountInRangeResult>>;
  query_new_bookings_in_range?(
    filter: CountRangeFilter,
    cfg: SchemaMap,
  ): Promise<OperatorDbResult<CountInRangeResult>>;

  query_collection?(
    collectionName: string,
    filter: Record<string, unknown>,
    options: GenericReadOptions,
    cfg: SchemaMap,
    allowedCollections: ReadonlySet<string>,
  ): Promise<OperatorDbResult<GenericReadResult>>;
  aggregate?(
    collectionName: string,
    pipeline: unknown[],
    options: GenericReadOptions,
    cfg: SchemaMap,
    allowedCollections: ReadonlySet<string>,
  ): Promise<OperatorDbResult<GenericReadResult>>;
};
