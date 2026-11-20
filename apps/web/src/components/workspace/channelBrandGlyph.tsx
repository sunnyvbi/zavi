import type { ReactNode } from "react";

const seo: ReactNode = (
  <svg viewBox="0 0 24 24" className="size-[19px]"><circle cx="10" cy="10" r="6.5" fill="none" stroke="#EA4335" strokeWidth="3" strokeDasharray="10.210176124166829 30.630528372500486" strokeDashoffset="0" transform="rotate(-135 10 10)" /><circle cx="10" cy="10" r="6.5" fill="none" stroke="#4285F4" strokeWidth="3" strokeDasharray="10.210176124166829 30.630528372500486" strokeDashoffset="-10.210176124166829" transform="rotate(-135 10 10)" /><circle cx="10" cy="10" r="6.5" fill="none" stroke="#34A853" strokeWidth="3" strokeDasharray="10.210176124166829 30.630528372500486" strokeDashoffset="-20.420352248333657" transform="rotate(-135 10 10)" /><circle cx="10" cy="10" r="6.5" fill="none" stroke="#FBBC04" strokeWidth="3" strokeDasharray="10.210176124166829 30.630528372500486" strokeDashoffset="-30.630528372500486" transform="rotate(-135 10 10)" /><path d="M14.8 14.8 20.5 20.5" stroke="#4285F4" strokeWidth="3.2" strokeLinecap="round" /></svg>
);

const geo: ReactNode = (
  <svg viewBox="0 0 24 24" className="size-[21px]"><defs><linearGradient id="ci-geo" x1="3" y1="3" x2="21" y2="21" gradientUnits="userSpaceOnUse"><stop stopColor="#4285F4" /><stop offset=".55" stopColor="#9B72CB" /><stop offset="1" stopColor="#D96570" /></linearGradient></defs><path d="M12 2c.5 5.3 4.7 9.5 10 10-5.3.5-9.5 4.7-10 10-.5-5.3-4.7-9.5-10-10 5.3-.5 9.5-4.7 10-10Z" fill="url(#ci-geo)" /></svg>
);

const email: ReactNode = (
  <svg viewBox="0 0 24 24" className="size-[20.5px]"><rect x="2" y="4.5" width="20" height="15" rx="3.5" fill="#1A73E8" /><path d="m5.5 8.5 6.5 4.6 6.5-4.6" fill="none" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

const GLYPHS: Record<string, ReactNode> = {
  seo: seo,
  geo: geo,
  email_marketing: email,
};

export function channelBrandGlyph(slug: string): ReactNode | null {
  return GLYPHS[slug.replace(/[-.]/g, "_")] ?? null;
}

export const BRAND_GLYPH_SLUGS = Object.keys(GLYPHS);
