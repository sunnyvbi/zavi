import { isPublicPath } from "@/lib/publicPaths";
import { plainNext } from "@/lib/safe-next";
import { urlAttribution, withUrlAttribution } from "./liveFrom";

function marketingPage(path: string): boolean {
  return isPublicPath(path) && !/^\/(?:auth|login|reset-password|invite|creator|creators|humans|shopify|connectors|r|r-Hg5x3K)(?:\/|$)/.test(path);
}

export function attributionLink(href: string, currentHref: string): string {
  try {
    if (!href || href.startsWith("#")) return href;
    const current = new URL(currentHref);
    if (!marketingPage(current.pathname)) return href;
    const tags = urlAttribution(current.search);
    if (!Object.keys(tags).length) return href;
    const target = new URL(href, current);
    if (target.origin !== current.origin || !plainNext(target.pathname)) return href;
    const path = target.pathname + target.search + target.hash;
    if (target.pathname === "/login") {
      const next = target.searchParams.get("next") ?? "/workspace";
      const nextPath = plainNext(next)?.split(/[?#]/)[0];
      if (!["/workspace", "/start", "/onboarding/past-work"].includes(nextPath ?? "")) return href;
      target.searchParams.set("next", withUrlAttribution(next, tags));
      const taggedLogin = target.pathname + target.search + target.hash;
      return taggedLogin === path ? href : taggedLogin;
    }
    if (!marketingPage(target.pathname) && target.pathname !== "/onboarding/past-work") return href;
    const tagged = withUrlAttribution(path, tags);
    return tagged === path ? href : tagged;
  } catch {
    return href;
  }
}

export function installAttributionLinks(navigate: (href: string) => void): () => void {
  const decorated = new WeakMap<HTMLAnchorElement, { original: string; tagged: string }>();
  const handle = (event: MouseEvent) => {
    if (event.defaultPrevented || !(event.target instanceof Element)) return;
    const anchor = event.target.closest<HTMLAnchorElement>("a[href]");
    if (!anchor || anchor.hasAttribute("download")) return;
    const actual = anchor.getAttribute("href")!;
    const previous = decorated.get(anchor);
    const href = previous?.tagged === actual ? previous.original : actual;
    const tagged = attributionLink(href, window.location.href);
    if (tagged === href) return;
    if (event.type === "click" && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && (!anchor.target || anchor.target === "_self")) {
      event.preventDefault();
      navigate(tagged);
    } else {
      decorated.set(anchor, { original: href, tagged });
      anchor.setAttribute("href", tagged);
    }
  };
  document.addEventListener("click", handle, true);
  document.addEventListener("auxclick", handle, true);
  document.addEventListener("contextmenu", handle, true);
  return () => {
    document.removeEventListener("click", handle, true);
    document.removeEventListener("auxclick", handle, true);
    document.removeEventListener("contextmenu", handle, true);
  };
}
