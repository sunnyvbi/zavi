
export const SLACK_WORKSPACE_HINT =
  "Slack signs you in to whichever workspace is active in your browser. Signing in to the wrong one? Open a private/incognito window, sign in to the Slack workspace you want, then come back and click Continue with Slack.";

export function SlackWorkspaceHint({ className }: { className?: string }) {
  return (
    <p
      className={
        className ??
        "text-[12px] leading-[1.55] tracking-[-0.15px] text-[#a1a1a1]"
      }
    >
      {SLACK_WORKSPACE_HINT}
    </p>
  );
}
