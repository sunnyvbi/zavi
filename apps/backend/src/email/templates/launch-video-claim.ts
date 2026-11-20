
import { renderEmail } from "../theme";

export function renderLaunchVideoClaimEmail(args: {
  actionUrl: string;
}): { html: string; text: string; subject: string } {
  const subject = "Your launch video is ready. Sign in to download it.";

  const html = renderEmail({
    preheader: "Sign in to grab the full-quality file and open your workspace.",
    kicker: "Launch video",
    eyebrow: "Ready to download",
    title: "Your launch video is <em>ready</em>",
    intro: "Click below to sign in. Your video is waiting in your Zavi workspace.",
    ctaText: "Sign in and download",
    ctaUrl: args.actionUrl,
    linkFallback: true,
    body: `
      <p>Didn't create a launch video? You can ignore this email.</p>
    `,
    footerNote: "For your security, this link works once and expires soon. Zavi will never ask you to share it.",
    footerVariant: "neutral",
  });

  const text = [
    "Your launch video is ready",
    "",
    "Sign in to download the full-quality file and open your workspace:",
    args.actionUrl,
    "",
    "This link works once and expires soon. If you didn't create a launch video, ignore this email.",
    "",
    "Zavi · zaviagent.com",
  ].join("\n");

  return { html, text, subject };
}
