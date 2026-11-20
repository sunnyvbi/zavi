
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectQR } from "../ChatConnectCard";

const TOKEN = "Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z";
const WA_URL = `https://api.whatsapp.com/send?phone=15551234567&text=${encodeURIComponent(
  `Connect Zavi: ${TOKEN}`,
)}`;

function pxPerModule(svg: string): number {
  const cells = Number(/viewBox="0 0 (\d+) \d+"/.exec(svg)![1]);
  const px = Number(/width="(\d+)"/.exec(svg)![1]);
  return px / cells;
}

describe("ConnectQR", () => {
  it("renders an inline SVG, never a third-party image URL", () => {
    const html = renderToStaticMarkup(<ConnectQR value={WA_URL} caption="Scan me" />);
    expect(html).toContain("<svg");
    expect(html).not.toContain("<img");
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
    expect(html).toContain("Scan me");
  });

  it("stays above ~3px per module on the real WhatsApp link, so it scans", () => {
    const html = renderToStaticMarkup(<ConnectQR value={WA_URL} caption="Scan me" />);
    expect(pxPerModule(html)).toBeGreaterThanOrEqual(3);
  });

  it("still scans if the business number is a longer international one", () => {
    const long = WA_URL.replace("15551234567", "819012345678901");
    const html = renderToStaticMarkup(<ConnectQR value={long} caption="Scan me" />);
    expect(pxPerModule(html)).toBeGreaterThanOrEqual(3);
  });

  it("keeps a quiet zone — a QR flush to its edge is unreliable", () => {
    const html = renderToStaticMarkup(<ConnectQR value={WA_URL} caption="Scan me" />);
    const cells = Number(/viewBox="0 0 (\d+) \d+"/.exec(html)![1]);
    expect(cells).toBeGreaterThan(41);
  });

  it("is black-on-white regardless of theme, so dark mode can't invert it", () => {
    const html = renderToStaticMarkup(<ConnectQR value={WA_URL} caption="Scan me" />);
    expect(html).toContain('fill="#ffffff"');
    expect(html).toContain('fill="#000000"');
  });
});
