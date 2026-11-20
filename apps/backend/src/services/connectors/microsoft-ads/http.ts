
import { ExpectedToolError } from "@/services/tools/types";
import { microsoftAdsDeveloperToken, microsoftAdsHost, type MicrosoftService } from "./constants";

export type MsScope = { customerId?: string; customerAccountId?: string };

type FaultItem = { Code?: number; ErrorCode?: string; Message?: string };
type Fault = { TrackingId?: string; OperationErrors?: FaultItem[]; BatchErrors?: FaultItem[]; Errors?: FaultItem[] };

function formatError(status: number, raw: string): { code: string; message: string } {
  let fault: Fault | null = null;
  try {
    fault = JSON.parse(raw) as Fault;
  } catch {
  }
  const items = [...(fault?.OperationErrors ?? []), ...(fault?.BatchErrors ?? []), ...(fault?.Errors ?? [])];
  const codes = new Set(items.map((i) => i.Code));
  if (codes.has(105)) {
    return {
      code: "microsoft_ads_invalid_credentials",
      message: "Microsoft Ads code 105 InvalidCredentials — check the developer token matches the environment (sandbox vs production).",
    };
  }
  if (codes.has(117)) return { code: "microsoft_ads_rate_limited", message: "Microsoft Ads code 117 CallRateExceeded — wait 60s." };
  if (status === 401) return { code: "microsoft_ads_forbidden", message: "Microsoft Ads HTTP 401 — reconnect Microsoft Ads." };
  const summary = items.map((i) => `${i.Code ?? "?"} ${i.ErrorCode ?? ""}`.trim()).join("; ");
  return {
    code: "microsoft_ads_error",
    message: `Microsoft Ads API HTTP ${status}${summary ? `: ${summary}` : ""}${fault?.TrackingId ? ` [TrackingId: ${fault.TrackingId}]` : ""}`,
  };
}

export async function microsoftAdsPost<T>(
  accessToken: string,
  service: MicrosoftService,
  path: string,
  body: unknown,
  scope: MsScope = {},
): Promise<T> {
  if (!/^[A-Za-z]+(?:\/[A-Za-z]+)*$/.test(path)) {
    throw new ExpectedToolError("microsoft_ads_bad_path", "microsoft_ads: invalid API path");
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    DeveloperToken: microsoftAdsDeveloperToken(),
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (scope.customerId) headers.CustomerId = scope.customerId;
  if (scope.customerAccountId) headers.CustomerAccountId = scope.customerAccountId;
  const resp = await fetch(`${microsoftAdsHost(service)}/${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  const raw = await resp.text();
  if (!resp.ok) {
    const e = formatError(resp.status, raw);
    throw new ExpectedToolError(e.code, e.message);
  }
  try {
    return (raw ? JSON.parse(raw) : {}) as T;
  } catch {
    throw new ExpectedToolError("microsoft_ads_bad_response", "Microsoft Ads API returned non-JSON.");
  }
}
