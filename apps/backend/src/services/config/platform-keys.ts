
import { processRole } from "./process-role";

export type PlatformKeyEntry = {
  code: string | null;
  feature: string;
  env: string[][];
  bootCheck: boolean;
  keepMessage: boolean;
};

const GOOGLE_APP = (prefix: string): string[][] => [
  [`${prefix}_CLIENT_ID`, "GOOGLE_ADS_CLIENT_ID"],
  [`${prefix}_CLIENT_SECRET`, "GOOGLE_ADS_CLIENT_SECRET"],
];

export const PLATFORM_KEYS: readonly PlatformKeyEntry[] = [
  {
    code: "youtube_api_key_missing",
    feature: "read YouTube data (subscribers, views, recent videos, search)",
    env: [["YOUTUBE_DATA_API_KEY"]],
    bootCheck: true,
    keepMessage: true,
  },
  {
    code: "youtube_api_forbidden",
    feature: "read YouTube data (subscribers, views, recent videos, search)",
    env: [["YOUTUBE_DATA_API_KEY"]],
    bootCheck: false,
    keepMessage: false,
  },
  {
    code: "google_ads_not_configured",
    feature: "work in Google Ads",
    env: [["GOOGLE_ADS_CLIENT_ID"], ["GOOGLE_ADS_CLIENT_SECRET"], ["GOOGLE_ADS_DEVELOPER_TOKEN"]],
    bootCheck: true,
    keepMessage: false,
  },
  {
    code: "google_calendar_not_configured",
    feature: "use Google Calendar",
    env: GOOGLE_APP("GOOGLE_CALENDAR"),
    bootCheck: true,
    keepMessage: false,
  },
  {
    code: "google_sheets_not_configured",
    feature: "use Google Sheets",
    env: GOOGLE_APP("GOOGLE_SHEETS"),
    bootCheck: true,
    keepMessage: false,
  },
  {
    code: "chatgpt_ads_not_configured",
    feature: "read ChatGPT ads",
    env: [["OPENAI_ADS_API_KEY"]],
    bootCheck: false,
    keepMessage: true,
  },
  {
    code: "chatgpt_ads_forbidden",
    feature: "read ChatGPT ads",
    env: [["OPENAI_ADS_API_KEY"]],
    bootCheck: false,
    keepMessage: true,
  },
  {
    code: "chatgpt_ads_conversion_unavailable",
    feature: "use conversion bidding on ChatGPT ads",
    env: [],
    bootCheck: false,
    keepMessage: true,
  },
  {
    code: "apify_not_configured",
    feature: "scrape public pages (social profiles, reviews, listings)",
    env: [["APIFY_TOKEN"]],
    bootCheck: true,
    keepMessage: false,
  },
  { code: "apify_auth_failed", feature: "scrape public pages (social profiles, reviews, listings)", env: [["APIFY_TOKEN"]], bootCheck: false, keepMessage: false },
  { code: "apify_quota_exhausted", feature: "scrape public pages (social profiles, reviews, listings)", env: [], bootCheck: false, keepMessage: false },
  {
    code: "web_search_not_configured",
    feature: "search the web",
    env: [["TAVILY_API_KEY"]],
    bootCheck: true,
    keepMessage: false,
  },
  { code: "web_search_auth_failed", feature: "search the web", env: [["TAVILY_API_KEY"]], bootCheck: false, keepMessage: false },
  {
    code: null,
    feature: "check Google search rankings",
    env: [["DATAFORSEO_LOGIN"], ["DATAFORSEO_PASSWORD"]],
    bootCheck: true,
    keepMessage: false,
  },
];

const BY_CODE = new Map(PLATFORM_KEYS.filter((e) => e.code).map((e) => [e.code as string, e]));

export function platformKeyFor(code: string | null | undefined): PlatformKeyEntry | null {
  return code ? (BY_CODE.get(code) ?? null) : null;
}

export function missingEnvFor(entry: PlatformKeyEntry, env: NodeJS.ProcessEnv = process.env): string[][] {
  return entry.env.filter((group) => !group.some((name) => (env[name] ?? "").trim() !== ""));
}

export function emptyPlatformKeys(env: NodeJS.ProcessEnv = process.env): PlatformKeyEntry[] {
  return PLATFORM_KEYS.filter((e) => e.bootCheck && missingEnvFor(e, env).length > 0);
}

export function envLabel(groups: string[][]): string {
  return groups.map((g) => (g.length > 1 ? `${g[0]} (or ${g.slice(1).join(", ")})` : g[0])).join(", ");
}

type BootDeps = {
  alert: (input: import("@/services/logging/alert").AlertInput) => Promise<void>;
  warn: (msg: string) => void;
  now: () => Date;
};

export async function reportEmptyPlatformKeys(
  env: NodeJS.ProcessEnv = process.env,
  deps: Partial<BootDeps> = {},
): Promise<string[]> {
  try {
    const empty = emptyPlatformKeys(env);
    if (empty.length === 0) return [];
    const lines = empty.map((e) => `${envLabel(missingEnvFor(e, env))}: Zavi cannot ${e.feature}`);
    const warn = deps.warn ?? ((m: string) => console.warn(m));
    warn(`[platform-keys] ${empty.length} Zavi platform key(s) empty: ${lines.join("; ")}`);
    const isProd =
      env.NODE_ENV === "production" && env.EXECUTION_ENV !== "staging" && env.PRAXIS_CONTAINER_ROLE === "canonical";
    if (!isProd) return lines;
    const role = processRole(env);
    const day = (deps.now ?? (() => new Date()))().toISOString().slice(0, 10);
    const alert = deps.alert ?? (await import("@/services/logging/alert")).alert;
    await alert({
      source: "platform-keys-boot",
      code: "platform_keys_empty",
      msg: `${empty.length} Zavi platform key(s) are empty on the ${role} host.`,
      email: {
        dedupeKey: `platform_keys_boot:${role}:${day}`,
        subjectDetail: `${empty.length} platform key(s) empty on ${role}`,
        detail: [
          `Host role: ${role}`,
          "",
          ...lines,
          "",
          "Fix: add the key to AWS Secrets Manager praxis-envprod-1, then restart BOTH the api and worker containers.",
          "One email per host role per day.",
        ].join("\n"),
      },
    });
    return lines;
  } catch (e) {
    console.warn(`[platform-keys] boot report failed: ${(e as Error).message}`);
    return [];
  }
}
