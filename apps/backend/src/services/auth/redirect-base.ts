import { withHttps } from "../web-base";

export function resolveAuthRedirectBase(): string | undefined {
  const raw = process.env.WEB_BASE_URL ?? process.env.WEB_ORIGIN ?? "";
  const origins = raw
    .split(",")
    .map((s) => withHttps(s))
    .filter(Boolean);
  const https = origins.filter((o) => /^https:\/\//i.test(o));
  const chosen =
    https.find((o) => /^https:\/\/www\./i.test(o)) ?? https[0] ?? origins[0];
  return chosen ? chosen.replace(/\/$/, "") : undefined;
}
