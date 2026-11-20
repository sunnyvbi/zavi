import { describe, expect, it } from "vitest";
import { LOGO_ICONS } from "../logo-icons";
import { SITE_LOGO_URL } from "../site-head";
import { logoIntent, parseLogoRecipe, renderSiteLogo, seedSiteLogo } from "../site-logo";

const COLORS = { primary: "#0f766e", primaryForeground: "#ffffff" };

describe("renderSiteLogo", () => {
  it("draws the header mark as the bare icon in the theme's primary, and the favicon as the icon on a primary tile", () => {
    const out = renderSiteLogo({ icon: "scissors", shape: "circle" }, COLORS)!;
    expect(out.logo.startsWith("<svg")).toBe(true);
    expect(out.logo).toContain('data-zavi-logo="mark"');
    expect(out.logo).toContain('stroke="#0f766e"');
    expect(out.logo).not.toContain("fill=\"#");
    expect(out.logo).not.toContain("<text");
    expect(out.favicon).toContain('<circle cx="32" cy="32" r="32" fill="#0f766e"/>');
    expect(out.favicon).toContain('stroke="#ffffff"');
    expect(out.favicon).toContain('data-zavi-logo="mark"');
    for (const svg of [out.logo, out.favicon]) {
      for (const [, attrs] of LOGO_ICONS.scissors) {
        for (const v of Object.values(attrs)) expect(svg).toContain(v);
      }
    }
    expect(renderSiteLogo({ icon: "scissors", shape: "rounded" }, COLORS)!.favicon).toContain('<rect width="64" height="64" rx="14" fill="#0f766e"/>');
  });

  it("draws nothing without an icon (no initials), and never prints anything but a valid colour", () => {
    expect(renderSiteLogo({ icon: null, shape: "rounded" }, COLORS)).toBeNull();
    expect(renderSiteLogo({ icon: "not-an-icon" as never, shape: "rounded" }, COLORS)).toBeNull();
    const hostile = renderSiteLogo({ icon: "sun", shape: "rounded" }, { primary: '"/><script>', primaryForeground: "red" })!;
    expect(hostile.logo + hostile.favicon).not.toContain("script");
    expect(hostile.logo).toContain('stroke="#111827"');
    expect(hostile.favicon).toContain('stroke="#ffffff"');
  });
});

describe("parseLogoRecipe", () => {
  it("keeps a known icon and shape, drops anything else, and keeps valid initials (the letter mark, 2026-10-09)", () => {
    expect(parseLogoRecipe({ icon: "Camera", shape: "circle" })).toEqual({ icon: "camera", shape: "circle" });
    expect(parseLogoRecipe({ icon: "not-an-icon", shape: "hexagon" })).toEqual({ icon: null, shape: "rounded" });
    expect(parseLogoRecipe({ icon: "camera", letters: "AB" })).toEqual({ icon: "camera", shape: "rounded", letters: "AB" });
    expect(parseLogoRecipe(null)).toBeNull();
  });
});

describe("logoIntent", () => {
  it("reads the founder's answer to the logo question from the idea", () => {
    expect(logoIntent("A shop\n\nAdditional context:\n- Logo: No logo, show the business name only.")).toBe("none");
    expect(logoIntent("A shop\n\nAdditional context:\n- Logo: Make a logo mark showing: a paper plane.")).toBe("describe");
    expect(logoIntent("A shop\n\nAdditional context:\n- Logo: Add a logo (the one I uploaded, else make a simple mark).")).toBe("yes");
    expect(logoIntent("A shop\n\nAdditional context:\n- Logo: Add a logo (use my uploaded logo if I have one; otherwise a simple icon that fits, or just the name if none does).")).toBe("yes");
    expect(logoIntent("A shop with no questions answered")).toBeNull();
  });
});

describe("seedSiteLogo", () => {
  const base = { stored: false, uploadedSvg: null as string | null, canShowLogo: true, colors: COLORS };
  const brief = { logo: { icon: "sun" as const, shape: "rounded" as const }, brand: { voice: "calm" } };

  it("draws the brief's mark by default and records it on the brief", () => {
    const out = seedSiteLogo({ ...base, brief, idea: "A yoga studio site" });
    expect(out.svg).toContain('data-zavi-logo="mark"');
    expect(out.svg).toContain('stroke="#0f766e"');
    expect(out.favicon).toContain('<rect width="64" height="64" rx="14" fill="#0f766e"/>');
    expect(out.brief.logo).toEqual({ icon: "sun", shape: "rounded" });
    expect(out.brief.brand).toEqual({ voice: "calm", logo: SITE_LOGO_URL });
  });

  it.each([
    ["no logo field", { brand: { voice: "calm" } }],
    ["an icon of null", { logo: { icon: null, shape: "rounded" as const }, brand: { voice: "calm" } }],
    ["an unknown icon", { logo: { icon: "cupcake" as never, shape: "rounded" as const }, brand: { voice: "calm" } }],
  ])("a brief with %s leaves the header to the name: no initials, and no logo claim", (_label, b) => {
    for (const idea of ["Cake Website, a bakery", "A bakery\n\nAdditional context:\n- Logo: Add a logo (the one I uploaded, else make a simple mark)."]) {
      const out = seedSiteLogo({ ...base, brief: b, idea });
      expect(out.svg).toBeNull();
      expect(out.favicon).toBeNull();
      expect("logo" in out.brief ? out.brief.logo : undefined).toBeUndefined();
      expect(out.brief.brand).toEqual({ voice: "calm" });
    }
  });

  it("a stored brief with initials and no icon is drawn as its letter mark on a Retry (Ravi 2026-10-09: the AI logo's fallback)", () => {
    const out = seedSiteLogo({ ...base, stored: true, brief: { logo: { icon: null, shape: "rounded", letters: "CW" }, brand: { logo: SITE_LOGO_URL } }, idea: "x" });
    expect(out.svg).toContain('data-zavi-logo="letters"');
    expect(out.svg).toContain(">CW</text>");
  });

  it("uses the uploaded logo unless the founder described a logo, and shows none after No logo", () => {
    const uploaded = "<svg>uploaded</svg>";
    const withUpload = seedSiteLogo({ ...base, brief: { ...brief, brand: { logo: SITE_LOGO_URL } }, uploadedSvg: uploaded, idea: "A bakery site" });
    expect(withUpload.svg).toBe(uploaded);
    expect(withUpload.favicon).toBe(uploaded);
    expect(withUpload.brief.logo).toBeUndefined();
    expect(withUpload.brief.brand).toEqual({ logo: SITE_LOGO_URL });

    const described = seedSiteLogo({
      ...base,
      brief,
      uploadedSvg: uploaded,
      idea: "A bakery site\n\nAdditional context:\n- Logo: Make a logo mark showing: a croissant.",
    });
    expect(described.svg).toContain('data-zavi-logo="mark"');

    const none = seedSiteLogo({ ...base, brief, uploadedSvg: uploaded, idea: "A law firm site\n\nAdditional context:\n- Logo: No logo, show the business name only." });
    expect(none.svg).toBeNull();
    expect(none.brief.logo).toBeUndefined();
    expect(none.brief.brand).toEqual({ voice: "calm" });
  });

  it("a stored brief (a Retry) decides from what it recorded, whatever the idea says now", () => {
    const marked = seedSiteLogo({ ...base, stored: true, brief: { logo: { icon: "sun", shape: "rounded" } }, idea: "- Logo: No logo." });
    expect(marked.svg).toContain(">");
    expect(marked.svg).toContain('data-zavi-logo="mark"');
    const uploaded = seedSiteLogo({ ...base, stored: true, brief: { brand: { logo: SITE_LOGO_URL } }, uploadedSvg: "<svg>u</svg>", idea: "x" });
    expect(uploaded.svg).toBe("<svg>u</svg>");
    const none = seedSiteLogo({ ...base, stored: true, brief: {}, uploadedSvg: "<svg>u</svg>", idea: "x" });
    expect(none.svg).toBeNull();
  });

  it("an uploaded logo that cannot be read on a Retry seeds none, and the brief stops claiming one", () => {
    const out = seedSiteLogo({ ...base, stored: true, brief: { brand: { voice: "calm", logo: SITE_LOGO_URL } }, uploadedSvg: null, idea: "x" });
    expect(out.svg).toBeNull();
    expect(out.brief.brand).toEqual({ voice: "calm" });
  });

  it("a starter whose header cannot show a logo gets none, and no logo claim", () => {
    const out = seedSiteLogo({ ...base, canShowLogo: false, brief: { ...brief, brand: { logo: SITE_LOGO_URL } }, uploadedSvg: "<svg>u</svg>", idea: "A gym site" });
    expect(out.svg).toBeNull();
    expect(out.brief.logo).toBeUndefined();
    expect(out.brief.brand).toEqual({});
  });

  it("the Yes answer the clarify step writes gets what its copy promises: the uploaded logo, else an icon that fits, else just the name", () => {
    const yes = "A bakery\n\nAdditional context:\n- Logo: Add a logo (use my uploaded logo if I have one; otherwise a simple icon that fits, or just the name if none does).";
    expect(logoIntent(yes)).toBe("yes");
    const uploaded = seedSiteLogo({ ...base, brief: { ...brief, brand: { logo: SITE_LOGO_URL } }, uploadedSvg: "<svg>u</svg>", idea: yes });
    expect(uploaded.svg).toBe("<svg>u</svg>");
    const icon = seedSiteLogo({ ...base, brief, idea: yes });
    expect(icon.svg).toContain('data-zavi-logo="mark"');
    expect(icon.brief.brand).toEqual({ voice: "calm", logo: SITE_LOGO_URL });
    const nameOnly = seedSiteLogo({ ...base, brief: { logo: { icon: null, shape: "rounded" as const }, brand: { voice: "calm" } }, idea: yes });
    expect(nameOnly.svg).toBeNull();
    expect(nameOnly.favicon).toBeNull();
    expect(nameOnly.brief.brand).toEqual({ voice: "calm" });
  });
});

describe("letter marks", async () => {
  const { logoLetters, parseLogoRecipe, renderSiteLogo } = await import("../site-logo");
  it("takes the first letter of the first two words, uppercased, and falls back to Z", () => {
    expect(logoLetters("Portland Cake Bakery")).toBe("PC");
    expect(logoLetters("ink & needle")).toBe("IN");
    expect(logoLetters("Lumen")).toBe("L");
    expect(logoLetters("  ")).toBe("Z");
  });
  it("keeps only 1-2 uppercase letters from a stored recipe and draws them on a brand tile (escaped, no icon)", () => {
    expect(parseLogoRecipe({ icon: null, letters: "<s>" })).toEqual({ icon: null, shape: "rounded" });
    const files = renderSiteLogo({ icon: null, shape: "rounded", letters: "PC" }, { primary: "#b83b5e", primaryForeground: "#ffffff" })!;
    expect(files.logo).toContain('data-zavi-logo="letters"');
    expect(files.logo).toContain('fill="#b83b5e"');
    expect(files.logo).toContain(">PC</text>");
    expect(files.favicon).toBe(files.logo);
  });
});
