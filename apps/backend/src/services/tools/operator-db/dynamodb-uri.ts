import { ExpectedToolError } from "@/services/tools/types";

export type ParsedDynamodbUri = {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string;
  sessionToken?: string;
};

export const DYNAMO_ENDPOINT_REJECTED =
  "Custom DynamoDB endpoints aren't supported. Remove the endpoint setting.";
export const DYNAMO_REGION_REJECTED = "That DynamoDB region isn't valid.";

const REGION_RE = /^[a-z]{2}(-gov|-iso[a-z]?)?-[a-z]+-\d{1,2}$/;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function assertAwsDynamoEndpoint(raw: string, region: string): string {
  const reject = (): never => {
    throw new ExpectedToolError("operator_db_endpoint_not_allowed", DYNAMO_ENDPOINT_REJECTED);
  };
  if (!REGION_RE.test(region)) reject();
  let e: URL;
  try {
    e = new URL(raw);
  } catch {
    return reject();
  }
  if (e.protocol !== "https:") reject();
  if (e.username || e.password || e.port) reject();
  if (e.search || e.hash || (e.pathname !== "" && e.pathname !== "/")) reject();
  if (/[?#]/.test(raw)) reject();
  const host = e.hostname.toLowerCase();
  const r = escapeRe(region);
  const allowed = [
    new RegExp(`^dynamodb(-fips)?\\.${r}\\.amazonaws\\.com(\\.cn)?$`),
    new RegExp(`^vpce-[a-z0-9-]+\\.dynamodb\\.${r}\\.vpce\\.amazonaws\\.com(\\.cn)?$`),
  ];
  if (!allowed.some((re) => re.test(host))) reject();
  return `https://${host}`;
}

export function parseDynamodbUri(uri: string): ParsedDynamodbUri {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    throw new ExpectedToolError(
      "operator_db_bad_connection_uri",
      "DynamoDB connection string is not a valid URI. Expected: dynamodb://<access_key>:<secret_key>@<region>",
    );
  }
  if (u.protocol !== "dynamodb:") {
    throw new ExpectedToolError(
      "operator_db_bad_connection_uri",
      `DynamoDB connection string must use the "dynamodb://" scheme (got "${u.protocol}").`,
    );
  }
  const region = decodeURIComponent(u.hostname || "");
  const accessKeyId = decodeURIComponent(u.username || "");
  const secretAccessKey = decodeURIComponent(u.password || "");
  if (!region) {
    throw new ExpectedToolError(
      "operator_db_bad_connection_uri",
      "DynamoDB connection string is missing the region (host part).",
    );
  }
  if (!REGION_RE.test(region)) {
    throw new ExpectedToolError("operator_db_bad_region", DYNAMO_REGION_REJECTED);
  }
  if (!accessKeyId || !secretAccessKey) {
    throw new ExpectedToolError(
      "operator_db_bad_connection_uri",
      "DynamoDB connection string is missing credentials. Expected: dynamodb://<access_key>:<secret_key>@<region>",
    );
  }
  const rawEndpoint = u.searchParams.get("endpoint");
  const endpoint = rawEndpoint ? assertAwsDynamoEndpoint(rawEndpoint, region) : undefined;
  const sessionToken = u.searchParams.get("session_token") || undefined;
  return { region, accessKeyId, secretAccessKey, endpoint, sessionToken };
}

