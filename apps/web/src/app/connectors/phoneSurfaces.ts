
export type PhoneSurfaceSlug = "whatsapp" | "imessage";

type PhoneSurface = {
  appName: string;
  readLink: (json: Record<string, unknown>) => { url: string; number: string };
  openLabel: string;
  openClassName: string;
  qrCaption: string;
  rosterBlurb: string;
};

const str = (v: unknown) => (typeof v === "string" ? v : "");

export const PHONE_SURFACES: Record<PhoneSurfaceSlug, PhoneSurface> = {
  whatsapp: {
    appName: "WhatsApp",
    readLink: (j) => ({ url: str(j.wa_url), number: str(j.business_number) ? `+${str(j.business_number)}` : "" }),
    openLabel: "Open WhatsApp",
    openClassName: "bg-[#25D366]",
    qrCaption: "No WhatsApp on this computer? Scan with your phone's camera and the message opens ready to send.",
    rosterBlurb:
      "Everyone who can message Zavi from WhatsApp in this workspace. Names come from each phone's WhatsApp profile at the time it was connected.",
  },
  imessage: {
    appName: "iMessage",
    readLink: (j) => ({ url: str(j.imessage_url), number: str(j.line) }),
    openLabel: "Open Messages",
    openClassName: "bg-[#0B84FE]",
    qrCaption: "On a computer? Scan with your iPhone's camera and Messages opens with the text ready to send.",
    rosterBlurb: "Everyone who can text Zavi from iMessage in this workspace.",
  },
};

export function isPhoneSurface(slug: string): slug is PhoneSurfaceSlug {
  return slug === "whatsapp" || slug === "imessage";
}
