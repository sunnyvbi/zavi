
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { NuqsAdapter } from "nuqs/adapters/next/app";

import { THEME_COLOR } from "@/lib/themeColor";
import { ServiceStatusBanner } from "@/components/workspace/ServiceStatusBanner";
import { SignedOutGuard } from "@/components/auth/SignedOutGuard";
import { WorkspaceOpenedReporter } from "@/components/workspace/WorkspaceOpenedReporter";

export const metadata: Metadata = {
  title: "Workspace · Zavi",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: THEME_COLOR.light },
    { media: "(prefers-color-scheme: dark)", color: THEME_COLOR.dark },
  ],
};

export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  return (
    <NuqsAdapter>
      <SignedOutGuard />
      {}
      <WorkspaceOpenedReporter />
      {}
      <ServiceStatusBanner />
      {children}
    </NuqsAdapter>
  );
}
