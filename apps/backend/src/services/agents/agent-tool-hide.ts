const HIDDEN: Readonly<Record<string, ReadonlySet<string>>> = {
  operator: new Set([
    "operator_db__query_bookings_by_geo_category",
    "operator_db__query_active_supply_by_geo_category",
    "operator_db__query_funnel_by_geo_category",
  ]),
};

export function isHiddenFromAgent(agent_slug: string | null | undefined, anthropic_name: string): boolean {
  return !!agent_slug && (HIDDEN[agent_slug]?.has(anthropic_name) ?? false);
}
