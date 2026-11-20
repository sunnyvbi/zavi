import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { SiteImage } from "../files/src/components/ui/image";
import { renderSitePhotoBlock } from "@/services/workspace-files/site-photos";

function jsxProps(snippet: string): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const m of snippet.matchAll(/(\w+)=(?:"([^"]*)"|\{\{([^}]*)\}\})/g)) {
    props[m[1]!] = m[2] !== undefined ? m[2] : JSON.parse(`{${m[3]!.replace(/(\w+)\s*:/g, '"$1":')}}`);
  }
  return props;
}

describe("renderSitePhotoBlock points at the starter's SiteImage", () => {
  it("the SiteImage example it gives renders the photo when passed to the real component", () => {
    const block = renderSitePhotoBlock(
      [{ sitePath: "/images/front-3f2a.jpg", downloadUrl: "https://x.supabase.co/a.jpg", name: "front.jpg", repoPath: "public/images/front-3f2a.jpg" }],
      "/home/user/repo",
    );
    const example = /<SiteImage\b([^`]*?)\/>/.exec(block)?.[1];
    expect(example).toBeTruthy();
    const markup = renderToStaticMarkup(createElement(SiteImage, jsxProps(example!) as Parameters<typeof SiteImage>[0]));
    const img = new JSDOM(`<body>${markup}</body>`).window.document.querySelector("img");
    expect(img?.getAttribute("src")).toBe("/images/front-3f2a.jpg");
    expect(block).toContain("src/components/ui/image");
  });
});
