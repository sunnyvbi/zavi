import localFont from "next/font/local";

export const jakartaBody = localFont({
  src: "./PlusJakartaSans-normal.woff2",
  weight: "400 700",
  style: "normal",
  variable: "--font-body",
  display: "swap",
});

export const jakarta = localFont({
  src: "./PlusJakartaSans-normal.woff2",
  weight: "200 800",
  style: "normal",
  variable: "--font-jakarta",
  display: "swap",
});

export const interUi = localFont({
  src: "./Inter-normal.woff2",
  weight: "400 600",
  style: "normal",
  variable: "--font-ui",
  display: "swap",
});

export const inter = localFont({
  src: "./Inter-normal.woff2",
  weight: "100 900",
  style: "normal",
  variable: "--font-inter",
  display: "swap",
});

export const reading = localFont({
  src: [
    { path: "./SourceSerif4-normal.woff2", weight: "400 600", style: "normal" },
    { path: "./SourceSerif4-italic.woff2", weight: "400 600", style: "italic" },
  ],
  variable: "--font-reading",
  display: "swap",
  adjustFontFallback: "Times New Roman",
});

export const code = localFont({
  src: "./JetBrainsMono-normal.woff2",
  weight: "400 500",
  style: "normal",
  variable: "--font-code",
  display: "swap",
});

export const jbmono = localFont({
  src: "./JetBrainsMono-normal.woff2",
  weight: "100 800",
  style: "normal",
  variable: "--font-jbmono",
  display: "swap",
});

export const caveat = localFont({
  src: "./Caveat-normal.woff2",
  weight: "600",
  style: "normal",
  display: "swap",
});

export const lato = localFont({
  src: [
    { path: "./Lato-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./Lato-700-normal.woff2", weight: "700", style: "normal" },
    { path: "./Lato-900-normal.woff2", weight: "900", style: "normal" },
  ],
  variable: "--font-lato",
  display: "swap",
});
