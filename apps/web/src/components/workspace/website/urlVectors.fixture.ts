export type UrlVector = { input: string; href: string | null; src: string | null };

export const URL_VECTORS: ReadonlyArray<UrlVector> = [
  { input: "https://example.com/x", href: "https://example.com/x", src: "https://example.com/x" },
  { input: "http://example.com", href: "http://example.com", src: null },
  { input: "mailto:a@b.com", href: "mailto:a@b.com", src: null },
  { input: "tel:+15551234", href: "tel:+15551234", src: null },
  { input: "/rel/path", href: "/rel/path", src: "/rel/path" },
  { input: "./img.png", href: "./img.png", src: "./img.png" },
  { input: "#anchor", href: "#anchor", src: null },
  { input: "  https://trim.me/x  ", href: "https://trim.me/x", src: "https://trim.me/x" },
  { input: "HTTPS://UP.CASE/A", href: "HTTPS://UP.CASE/A", src: "HTTPS://UP.CASE/A" },
  { input: "https://my-hyphen-host.com/a-b", href: "https://my-hyphen-host.com/a-b", src: "https://my-hyphen-host.com/a-b" },

  { input: "javascript:alert(1)", href: null, src: null },
  { input: "JaVaScRiPt:alert(1)", href: null, src: null },
  { input: "data:text/html,x", href: null, src: null },
  { input: "vbscript:msgbox", href: null, src: null },
  { input: "file:///etc/passwd", href: null, src: null },
  { input: "//evil.com", href: null, src: null },
  { input: "\\\\evil.com", href: null, src: null },
  { input: "https://x.com/%00", href: null, src: null },
  { input: "java\tscript:alert(1)", href: null, src: null },
  { input: "https://x.com/a b", href: null, src: null },
  { input: "", href: null, src: null },
  { input: `https://x.com/${"a".repeat(3000)}`, href: null, src: null },
];
