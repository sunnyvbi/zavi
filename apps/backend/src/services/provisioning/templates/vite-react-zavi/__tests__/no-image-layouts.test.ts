import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Cake, CalendarCheck, Camera, Images, Stethoscope, Truck } from "lucide-react";
import { Hero } from "../files/src/components/sections/Hero";
import { Features } from "../files/src/components/sections/Features";
import { Gallery } from "../files/src/components/sections/Gallery";
import { CTA } from "../files/src/components/sections/CTA";
import { SiteImage, hasImage } from "../files/src/components/ui/image";

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const IMAGE_ICON = /lucide-image/;

const SHAPES = [
  { name: "bakery order form", title: "Fresh bread daily", items: [{ title: "Custom cakes", body: "Order 48h ahead", icon: Cake }, { title: "Delivery", body: "Same day", icon: Truck }] },
  { name: "dentist booking", title: "Gentle dental care", items: [{ title: "Checkups", body: "Twice a year", icon: Stethoscope }, { title: "Book online", body: "Pick a time", icon: CalendarCheck }] },
  { name: "photographer portfolio", title: "Wedding photography", items: [{ title: "Portraits", body: "Studio or outdoor", icon: Camera }, { title: "Albums", body: "Printed", icon: Images }] },
];

describe("starter no-image layouts", () => {
  for (const shape of SHAPES) {
    describe(shape.name, () => {
      it("Hero split with no photo becomes the centered layout: no photo frame at all", () => {
        for (const image of [undefined, null, { src: "", alt: "" }]) {
          const out = html(createElement(Hero, { variant: "split", title: shape.title, image }));
          expect(out).toContain("text-center");
          expect(out).not.toContain("data-zavi-image");
          expect(out).not.toMatch(IMAGE_ICON);
        }
      });

      it("Hero image with no photo is a full-bleed brand gradient with the copy on top", () => {
        const out = html(createElement(Hero, { variant: "image", title: shape.title }));
        expect(out).toContain('data-zavi-image="none"');
        expect(out).toContain("from-primary");
        expect(out).toContain(shape.title);
        expect(out).not.toMatch(IMAGE_ICON);
      });

      it("Features alternating with no photos shows each item's icon on a brand panel", () => {
        const out = html(createElement(Features, { variant: "alternating", title: "What we do", items: shape.items }));
        expect(out.match(/data-zavi-image="none"/g)?.length).toBe(shape.items.length);
        for (const item of shape.items) expect(out).toContain(item.title);
      });

      it("Gallery drops entries with no file, and renders nothing when none has one", () => {
        expect(html(createElement(Gallery, { title: "Work", images: [{ src: "", alt: "x" }] }))).toBe("");
        const out = html(createElement(Gallery, { title: "Work", images: [{ src: "/images/a-960.webp", alt: "A" }, { src: " ", alt: "B" }] }));
        expect(out.match(/<img /g)?.length).toBe(1);
      });

      it("CTA split with no photo renders as the banner", () => {
        const out = html(createElement(CTA, { variant: "split", title: "Visit us" }));
        expect(out).not.toContain("data-zavi-image");
        expect(out).toContain("text-center");
      });
    });
  }

  it("a real photo still renders, with the srcset, size and dimensions add_site_images returns", () => {
    const image = { src: "/images/hero-1600.webp", alt: "Bread on a counter", srcset: "/images/hero-1600.webp 1600w, /images/hero-800.webp 800w", width: 1600, height: 900 };
    expect(hasImage(image)).toBe(true);
    const out = html(createElement(SiteImage, { image, aspect: "wide", priority: true }));
    expect(out).toContain('srcSet="/images/hero-1600.webp 1600w, /images/hero-800.webp 800w"');
    expect(out).toContain('sizes="100vw"');
    expect(out).toContain('width="1600"');
    expect(out).toContain('alt="Bread on a counter"');
    const split = html(createElement(Hero, { variant: "split", title: "x", image }));
    expect(split).toContain("<img");
    expect(split).not.toContain("data-zavi-image");
  });

  it("SiteImage with no photo is a decorative brand panel: hidden from screen readers, no icon, no label", () => {
    const out = html(createElement(SiteImage, { image: null }));
    expect(out).toContain('aria-hidden="true"');
    expect(out).toContain('data-zavi-image="none"');
    expect(out).not.toMatch(IMAGE_ICON);
    expect(out).not.toMatch(/>\s*(image|photo)\s*</i);
  });
});
