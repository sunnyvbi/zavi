export const KLAVIYO_ACTION_SCOPES: Readonly<Record<string, readonly string[]>> = {
  KLAVIYO_GET_ACCOUNTS: ["accounts:read"],
  KLAVIYO_GET_LISTS: ["lists:read"],
  KLAVIYO_GET_LIST: ["lists:read"],
  KLAVIYO_GET_METRICS: ["metrics:read"],
  KLAVIYO_GET_CAMPAIGNS: ["campaigns:read"],
  KLAVIYO_GET_CAMPAIGN: ["campaigns:read"],
  KLAVIYO_GET_CAMPAIGN_SEND_JOB: ["campaigns:read"],
  KLAVIYO_GET_CAMPAIGN_RECIPIENT_ESTIMATION_JOB: ["campaigns:read"],
  KLAVIYO_GET_CAMPAIGN_RECIPIENT_ESTIMATION: ["campaigns:read"],
  KLAVIYO_QUERY_CAMPAIGN_VALUES: ["campaigns:read"],
  KLAVIYO_CREATE_CAMPAIGN: ["campaigns:write"],
  KLAVIYO_UPDATE_CAMPAIGN_MESSAGE: ["campaigns:write"],
  KLAVIYO_ASSIGN_CAMPAIGN_MESSAGE_TEMPLATE: ["campaigns:write"],
  KLAVIYO_CREATE_CAMPAIGN_RECIPIENT_ESTIMATION_JOB: ["campaigns:write"],
  KLAVIYO_CREATE_CAMPAIGN_SEND_JOB: ["campaigns:write"],
  KLAVIYO_GET_CAMPAIGN_MESSAGE_TEMPLATE: ["campaigns:read", "templates:read"],
  KLAVIYO_CREATE_TEMPLATE: ["templates:write"],
  KLAVIYO_CREATE_TEMPLATE_RENDER: ["templates:read"],
};

export const KLAVIYO_KEY_SCOPES: readonly string[] = [...new Set(Object.values(KLAVIYO_ACTION_SCOPES).flat())].sort();

const AREA_NAMES: Readonly<Record<string, string>> = { accounts: "Accounts", campaigns: "Campaigns", lists: "Lists", metrics: "Metrics", templates: "Templates" };

function areaName(area: string): string {
  return AREA_NAMES[area] ?? area.charAt(0).toUpperCase() + area.slice(1);
}

function joinAnd(items: readonly string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function keyInstruction(scopes: readonly string[]): string {
  const areas = [...new Set(scopes.map((s) => s.split(":")[0]))].sort();
  const full = areas.filter((a) => scopes.includes(`${a}:write`));
  const read = areas.filter((a) => !full.includes(a));
  const parts = [read.length ? `Read access to ${joinAnd(read.map(areaName))}` : "", full.length ? `Full access to ${joinAnd(full.map(areaName))}` : ""].filter(Boolean);
  return `In Klaviyo, create a Private API key under Settings > API keys with ${parts.join(", and ")} (scopes ${scopes.join(", ")}).`;
}

export const KLAVIYO_KEY_INSTRUCTION = keyInstruction(KLAVIYO_KEY_SCOPES);
