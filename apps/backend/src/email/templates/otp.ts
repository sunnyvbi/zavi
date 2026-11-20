
import { renderEmail } from "../theme";

export type OtpPurpose = "signin" | "signup";

export function renderOtpEmail(args: {
  code: string;
  expiresInMinutes?: number;
  purpose?: OtpPurpose;
}): { html: string; text: string; subject: string } {
  const code = args.code;
  const exp = args.expiresInMinutes ?? 60;

  if (args.purpose === "signup") {
    const html = renderEmail({
      preheader: `Confirm your email to finish creating your Zavi account. Expires in ${exp} minutes.`,
      kicker: "Sign up",
      eyebrow: "Confirm your email",
      title: "Confirm your <em>email</em>",
      intro: "Use this code to finish creating your Zavi account.",
      heroNumber: code,
      heroLabel: `Expires in ${exp} minutes. Works once.`,
      body: `
      <p>Enter it on the sign-up screen, in the tab where you started.</p>
      <p>Didn't sign up for Zavi? Ignore this email. Nobody can use the account without this code.</p>
    `,
      footerNote: "Zavi will never ask you to share this code with anyone.",
      footerVariant: "neutral",
    });
    const text = [
      `Your Zavi code: ${code}`,
      "",
      `Enter it on the sign-up screen to confirm your email. Expires in ${exp} minutes.`,
      "",
      "Didn't sign up for Zavi? Ignore this email. Nobody can use the account without this code.",
      "",
      "Zavi · zaviagent.com",
    ].join("\n");
    return { html, text, subject: `Your Zavi code is ${code}: confirm your email` };
  }

  const subject = `Your Zavi sign-in code is ${code}`;

  const html = renderEmail({
    preheader: `Your Zavi sign-in code is ${code}. Expires in ${exp} minutes.`,
    kicker: "Sign in",
    eyebrow: "One-time code",
    title: "Your sign-in <em>code</em>",
    intro: "Use this code to finish signing in to Zavi.",
    heroNumber: code,
    heroLabel: `Expires in ${exp} minutes. Works once.`,
    body: `
      <p>Enter it on the sign-in screen, in the tab where you started or a new one.</p>
      <p>Didn't ask for a code? You can ignore this email.</p>
    `,
    footerNote: "Zavi will never ask you to share this code with anyone.",
    footerVariant: "neutral",
  });

  const text = [
    `Your Zavi sign-in code: ${code}`,
    "",
    `Paste it into the sign-in screen. Expires in ${exp} minutes.`,
    "",
    "Didn't request this? Ignore this email. The code expires automatically.",
    "",
    "Zavi · zaviagent.com",
  ].join("\n");

  return { html, text, subject };
}
