
import { firstNameOf, oneLine, renderCreatorLetter, type Rendered } from "./creator-simple-layout";

export function renderInviteMessageEmail(args: {
  name: string;
  businessName: string;
  signupUrl: string;
  unsubscribeUrl: string;
  siteUrl: string;
}): Rendered {
  const brand = oneLine(args.businessName, 60);
  return renderCreatorLetter({
    subject: `${brand} sent you a message on Zavi`,
    preheader: "A new collaboration request is waiting on Zavi.",
    firstName: oneLine(firstNameOf(args.name), 60),
    paragraphs: [
      `${brand} sent you a message on Zavi.`,
      "We are building Zavi for a future where AI helps businesses find and work with creators. Your ideas and creativity have a place in that future.",
      "Open Zavi to view their request, share your work and rates, and start a conversation. No signup needed: we email you a code to sign in.",
    ],
    button: { label: "View request", url: args.signupUrl },
    after: ["You choose which collaborations to explore and agree on the details with the brand."],
    footerReason: "You're getting this because a business on Zavi found your public creator profile.",
    unsubscribeUrl: args.unsubscribeUrl,
    siteUrl: args.siteUrl,
  });
}
