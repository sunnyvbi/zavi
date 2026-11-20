import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Get started · Zavi",
  robots: { index: false, follow: true },
};

export default function StartLayout({ children }: { children: React.ReactNode }) {
  return children;
}
