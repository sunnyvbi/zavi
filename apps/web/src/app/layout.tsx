import { SignupLocationCapture } from "@/components/SignupLocationCapture";
import type { Metadata, Viewport } from "next";
import { jakartaBody as body, interUi as ui, reading, code } from "@/fonts";
import "./globals.css";
import "./workspace-dark.css";
import { ChunkLoadRecovery } from "@/components/ChunkLoadRecovery";
import { MagicLinkFragmentCatcher } from "@/components/MagicLinkFragmentCatcher";
import { AttributionLinks } from "@/components/AttributionLinks";
import { FirstTouchCapture } from "@/components/FirstTouchCapture";
import { InAppHandoff } from "@/components/InAppHandoff";
import { PostHogProvider } from "./PostHogProvider";
import { MixpanelProvider } from "@/lib/analytics/mixpanel";
import { GoogleAnalyticsProvider } from "@/lib/analytics/google";
import { ClickTracking } from "@/lib/analytics/clicks";
import { AuthEventTracking } from "@/lib/analytics/auth";
import { SiteStructuredData } from "@/components/marketing/StructuredData";
import { CookieBanner } from "@/components/marketing/CookieBanner";
import { Toaster } from "@/components/ui/toast";
import { ConfirmDialogHost } from "@/components/ui/ConfirmDialog";
import { MirrorBanner } from "@/components/MirrorBanner";
import { TenantDisabledNotice } from "@/components/TenantDisabledNotice";
import { THEME_COLOR, THEME_COLOR_META_SELECTOR } from "@/lib/themeColor";
import { headers } from "next/headers";
import { SHOPIFY_APP_HOME_REQUEST_HEADER } from "@/lib/shopify-app-home/config";
import { ShopifyAppBridgeHead } from "@/components/shopify-app-home/ShopifyAppBridgeHead";

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, "") ||
  "https://www.zaviagent.com";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "Zavi: AI Growth Agent For Your Business",
  description:
    "Zavi is an AI growth agent for your business. It reads your business, writes the growth plan, runs the channels with your approval, and tells you what changed. Start free with free credits every day, no card and no sales call.",
  openGraph: {
    title: "Zavi: AI Growth Agent For Your Business",
    description:
      "Zavi is an AI growth agent for your business. It reads your business, writes the growth plan, runs the channels with your approval, and tells you what changed. Start free with free credits every day, no card and no sales call.",
    url: SITE_URL,
    siteName: "Zavi",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    site: "@zaviagent",
    title: "Zavi: AI Growth Agent For Your Business",
    description:
      "Zavi is an AI growth agent for your business. It reads your business, writes the growth plan, runs the channels with your approval, and tells you what changed. Start free with free credits every day, no card and no sales call.",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

const THEME_BOOT = `(function(){try{if(location.pathname.indexOf("/workspace")!==0&&location.pathname!=="/connectors/composio/done")return;var d=localStorage.getItem("zavi:dark");var k=d==="1"||(d===null&&matchMedia("(prefers-color-scheme: dark)").matches);if(k)document.documentElement.classList.add("dark");var c=k?${JSON.stringify(THEME_COLOR.dark)}:${JSON.stringify(THEME_COLOR.light)};var m=document.head.querySelectorAll(${JSON.stringify(THEME_COLOR_META_SELECTOR)});for(var i=0;i<m.length;i++)m[i].setAttribute("content",c)}catch(e){}})()`;

const STORAGE_ORIGIN = (() => {
  try {
    return process.env.NEXT_PUBLIC_SUPABASE_URL
      ? new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).origin
      : null;
  } catch {
    return null;
  }
})();

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const isShopifyAppHome = (await headers()).get(SHOPIFY_APP_HOME_REQUEST_HEADER) === "1";
  return (
    <html
      lang="en"
      className={`${body.variable} ${ui.variable} ${reading.variable} ${code.variable}`}
      suppressHydrationWarning
    >
      <head>
        {STORAGE_ORIGIN && (
          <>
            <link rel="preconnect" href={STORAGE_ORIGIN} crossOrigin="anonymous" />
            <link rel="dns-prefetch" href={STORAGE_ORIGIN} />
          </>
        )}
        <ShopifyAppBridgeHead enabled={isShopifyAppHome} />
      </head>
      <body className="font-body antialiased" suppressHydrationWarning>
        <script id="zavi-theme-boot" dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
        <MirrorBanner />
        <SiteStructuredData />
        {}
        <CookieBanner />
        <PostHogProvider>
          <MixpanelProvider>
            <GoogleAnalyticsProvider>
              <ChunkLoadRecovery />
              <MagicLinkFragmentCatcher />
              <FirstTouchCapture />
              <InAppHandoff />
              <AttributionLinks />
              <ClickTracking />
              <AuthEventTracking />
              <SignupLocationCapture />
              {children}
              <Toaster />
              <ConfirmDialogHost />
              <TenantDisabledNotice />
            </GoogleAnalyticsProvider>
          </MixpanelProvider>
        </PostHogProvider>
      </body>
    </html>
  );
}
