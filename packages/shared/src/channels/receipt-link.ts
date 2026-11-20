
const BY_HOST: ReadonlyArray<readonly [string, string]> = [
  ["github.com", "View pull request"],
  ["mailchimp.com", "View campaign"],
  ["klaviyo.com", "View campaign"],
  ["linkedin.com", "View post"],
];

export function receiptLinkLabel(url: string): string {
  const m = /^https:\/\/([^/?#:@\s]+)/i.exec(url.trim());
  if (!m) return "View it";
  const host = m[1].toLowerCase();
  for (const [h, label] of BY_HOST) if (host === h || host.endsWith(`.${h}`)) return label;
  return "View it";
}

export const PHONE_APPROVE_EXEC: ReadonlySet<string> = new Set(["seo.create_pr.v1", "geo.create_pr.v1", "generated_video.render.v1"]);

const PHONE_AD_EXEC = /^(?:meta_ads|google_ads|tiktok_ads|reddit_ads|x_ads|linkedin_ads|chatgpt_ads)\./;

export function phoneApprovesExec(execClass: string | null | undefined): boolean {
  if (!execClass) return false;
  return PHONE_APPROVE_EXEC.has(execClass) || PHONE_AD_EXEC.test(execClass);
}

export const EMAIL_SEND_EXEC = "email_campaign.create_and_send";
