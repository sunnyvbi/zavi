export type InboxLink = { id: "gmail" | "outlook" | "proton"; name: string; logo: string; href: string };

const SENDER = "support@zaviagent.com";
const OUTLOOK_PERSONAL = new Set(["outlook.com", "hotmail.com", "live.com", "msn.com"]);

export function inboxLinks(email: string): InboxLink[] {
  const address = email.trim().toLowerCase();
  const domain = address.split("@")[1] ?? "";
  const gmailSearch = encodeURIComponent(`from:${SENDER} in:anywhere newer_than:1d`);
  const gmailAccount = address ? `?authuser=${encodeURIComponent(address)}` : "";
  return [
    { id: "gmail", name: "Gmail", logo: "/logos/gmail-icon.svg", href: `https://mail.google.com/mail/u/${gmailAccount}#search/${gmailSearch}` },
    { id: "outlook", name: "Outlook", logo: "/logos/outlook-icon.svg", href: OUTLOOK_PERSONAL.has(domain) ? "https://outlook.live.com/mail/0/" : "https://outlook.office.com/mail/" },
    { id: "proton", name: "Proton", logo: "/logos/proton-mail-icon.svg", href: `https://mail.proton.me/u/0/all-mail#from=${encodeURIComponent(SENDER)}` },
  ];
}
