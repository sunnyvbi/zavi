import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Your Company",
  description: "A starter app, provisioned and ready to build on.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        {children}
        {}
        <script src="https://www.zaviagent.com/zavi-editor-runtime.js" defer />
        {}
        <script src="/zavi-picker.js" defer />
      </body>
    </html>
  );
}
