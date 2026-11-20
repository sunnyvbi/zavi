export const REDDIT_SOCIAL_SLUG = "reddit_social";

export const REDDIT_SOCIAL_ACCESS_TOKEN_KEY = `${REDDIT_SOCIAL_SLUG}.access_token`;
export const REDDIT_SOCIAL_REFRESH_TOKEN_KEY = `${REDDIT_SOCIAL_SLUG}.refresh_token`;
export const REDDIT_SOCIAL_USERNAME_KEY = `${REDDIT_SOCIAL_SLUG}.username`;

export const REDDIT_ACCESS_TOKEN_TTL_SEC = 3600;

export function redditUserAgent(): string {
  return process.env.REDDIT_SOCIAL_USER_AGENT?.trim() || "web:com.zaviagent.social:v1.0 (by /u/DeveloperZavi)";
}
