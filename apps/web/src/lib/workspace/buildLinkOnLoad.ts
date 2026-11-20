const BUILD_PARAM = "build";

const linkedOnLoad: string | null =
  typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get(BUILD_PARAM);

export function buildLinkedOnLoad(sessionId: string | null): boolean {
  return !!sessionId && sessionId === linkedOnLoad;
}

export function urlWithoutBuild(href: string): string {
  const url = new URL(href);
  url.searchParams.delete(BUILD_PARAM);
  url.searchParams.delete("buildThread");
  return url.toString();
}

export function reloadWithoutBuild(location: Pick<Location, "href" | "reload" | "replace"> = window.location): void {
  const next = urlWithoutBuild(location.href);
  if (next === location.href) location.reload();
  else location.replace(next);
}
