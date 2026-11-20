
import { firstNameOf, oneLine, renderCreatorLetter, type Rendered } from "./creator-simple-layout";

export function renderCreatorInviteEmail(args: {
  name: string;
  signupUrl: string;
  siteUrl: string;
  unsubscribeUrl: string;
}): Rendered {
  return renderCreatorLetter({
    subject: "Bring your creative work to Zavi",
    preheader: "A place for creators in the future of AI powered business.",
    firstName: oneLine(firstNameOf(args.name), 60),
    paragraphs: [
      "As AI becomes part of how businesses work, we want creators to be part of that future. We are building Zavi to help businesses find and work with people like you.",
      "Your profile gives businesses a place to discover your work, see your rates, and contact you about collaborations. You decide which requests to explore.",
      "We would love to have you on Zavi.",
    ],
    button: { label: "Signup", url: args.signupUrl },
    footerReason: "You're getting this because your public creator profile lists this address for brand work.",
    unsubscribeUrl: args.unsubscribeUrl,
    siteUrl: args.siteUrl,
  });
}
