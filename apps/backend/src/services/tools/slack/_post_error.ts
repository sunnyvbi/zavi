
export type SlackPostError = {
  code: string;
  detail: string;
};

const UNKNOWN = "post_failed_unknown";

export function slackPostErrorFrom(content: unknown): SlackPostError {
  if (typeof content !== "string" || content.length === 0) {
    return { code: UNKNOWN, detail: "" };
  }
  try {
    const parsed = JSON.parse(content) as {
      error?: unknown;
      message?: unknown;
      slack_error?: unknown;
    };
    const code =
      (typeof parsed.slack_error === "string" && parsed.slack_error) ||
      (typeof parsed.error === "string" && parsed.error) ||
      UNKNOWN;
    const detail = typeof parsed.message === "string" ? parsed.message : "";
    return { code, detail: detail.slice(0, 300) };
  } catch {
    return { code: UNKNOWN, detail: content.slice(0, 300) };
  }
}
