
import { slackFetch } from "@/services/tools/slack/_client";
import { ExpectedToolError } from "@/services/tools/types";

const RETRY_AFTER_MAX_SEC = 30;

export type SlackFetchResult<T = unknown> = {
  ok: boolean;
  data: T | null;
  error?: string;
  rate_limit_hits: number;
};

export async function slackFetchWithBackoff<T = Record<string, unknown>>(
  tenant_id: string,
  method: string,
  body: Record<string, string | number | boolean | undefined> = {},
  maxRetries: number = 3,
  team_id?: string,
): Promise<SlackFetchResult<T>> {
  let rate_limit_hits = 0;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const data = await slackFetch<T>(tenant_id, method, body, team_id);
      return { ok: true, data, rate_limit_hits };
    } catch (e) {
      const isExpected = e instanceof ExpectedToolError;
      const code = isExpected ? e.code : "unknown";
      const meta = (isExpected ? e.meta : undefined) as
        | { status?: number; slack_error?: string }
        | undefined;
      const status = meta?.status;
      const slackError = meta?.slack_error;
      const msg = (e as Error).message ?? "";

      const isRateLimited =
        status === 429 ||
        (code === "slack_api_error" && /ratelimited/i.test(msg));
      const isTransientHttp =
        code === "slack_http" && typeof status === "number" && status >= 500;
      const isRoutineSlackError = code === "slack_api_error" && !isRateLimited;

      if (isRoutineSlackError) {
        return {
          ok: false,
          data: null,
          error: slackError ?? "unknown",
          rate_limit_hits,
        };
      }

      if (isRateLimited) {
        rate_limit_hits += 1;
      }

      if (!isRateLimited && !isTransientHttp) {
        throw e;
      }

      if (attempt === maxRetries) {
        return {
          ok: false,
          data: null,
          error: isRateLimited ? "ratelimited" : `http_${status ?? "5xx"}`,
          rate_limit_hits,
        };
      }

      const backoffSec = Math.min(
        Math.pow(2, attempt + 1),
        RETRY_AFTER_MAX_SEC,
      );
      await sleep(backoffSec * 1000);
    }
  }
  return { ok: false, data: null, error: "unreachable", rate_limit_hits };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
