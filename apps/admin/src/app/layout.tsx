import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { cn } from "@/lib/utils";

const display = localFont({
  src: "./fonts/PlusJakartaSans-latin.woff2",
  weight: "500 700",
  variable: "--font-display",
  display: "swap",
});

const body = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-body",
  display: "swap",
});

const mono = localFont({
  src: "./fonts/JetBrainsMono-latin.woff2",
  weight: "400 500",
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Zavi Admin",
  description: "Internal Zavi admin dashboard.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={cn(display.variable, body.variable, mono.variable, "font-sans")}
      style={{ ["--font-sans" as string]: "var(--font-body)" }}
    >
      <body className="font-body antialiased">{children}</body>
    </html>
  );
}
