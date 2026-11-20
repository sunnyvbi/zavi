"use client";

import { useState } from "react";
import Image from "next/image";
import { AppWindow } from "lucide-react";
import { cn } from "@/lib/cn";
import { CONNECTOR_ICON } from "../settings/connectorLogos";

const EXTRA_ICONS: Record<string, string> = {
  "composio.shopify": "/logos/shopify-icon.svg",
  "composio.hubspot": "/logos/hubspot-icon.svg",
  "composio.mailchimp": "/logos/mailchimp-icon.svg",
  "composio.klaviyo": "/logos/klaviyo-tile-icon.svg",
  email: "/logos/sendgrid-icon.svg",
  tiktok_ads: "/logos/tiktok-channel.svg",
  microsoft_ads: "/logos/microsoft.svg",
  pinterest_ads: "/logos/pinterest-channel.svg",
  spotify_ads: "/logos/spotify.svg",
};
export function ConnectAppLogo({ slug, logo, small = false }: { slug: string; logo?: string; small?: boolean }) {
  const [failed, setFailed] = useState(false);
  const source = CONNECTOR_ICON[slug] ?? EXTRA_ICONS[slug] ?? (logo && /^https?:\/\//.test(logo) ? logo : null);
  const classes = small ? "h-6 w-6" : "h-8 w-8";
  if (!source || failed) return <AppWindow className={cn("shrink-0 text-onboarding-muted", classes)} aria-hidden />;
  return <Image src={source} width={32} height={32} alt="" unoptimized referrerPolicy="no-referrer" className={cn("shrink-0 object-contain", classes)} onError={() => setFailed(true)} />;
}
