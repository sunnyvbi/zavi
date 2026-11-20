export const CREATOR_MARKETPLACE_ENABLED: boolean = true;

export function creatorMarketplaceApiPath(pathname: string, method = "GET", enabled: boolean = CREATOR_MARKETPLACE_ENABLED): boolean {
  if (enabled) return false;
  const path = pathname.toLowerCase();
  const verb = method.toUpperCase();

  if (
    path === "/api/creator/home" ||
    path === "/api/creator/me" ||
    (verb === "PATCH" && path === "/api/creator/profile") ||
    (verb === "GET" && ["/api/creator/profile", "/api/creator/intro-video", "/api/creator/inbox", "/api/creator/threads", "/api/creator/earnings", "/api/creator/reviews", "/api/creator/storefront"].includes(path)) ||
    path.startsWith("/api/creator/jobs/") ||
    path === "/api/creator/jobs" ||
    path.startsWith("/api/creator/notifications/") ||
    path.startsWith("/api/creator/payouts/") ||
    (verb === "GET" && path === "/api/creators/threads") ||
    ((verb === "GET" || verb === "POST") && /^\/api\/creators\/threads\/[^/]+\/messages$/.test(path)) ||
    (verb === "GET" && /^\/api\/creators\/threads\/[^/]+\/offers$/.test(path)) ||
    (verb === "GET" && (path === "/api/humans/orders" || (/^\/api\/humans\/orders\/[^/]+$/.test(path) && path !== "/api/humans/orders/quote"))) ||
    /^\/api\/humans\/orders\/[^/]+\/(actions|fulfil|publications|review)$/.test(path) ||
    path.startsWith("/api/humans/publications/") ||
    path === "/api/humans/notifications" ||
    path === "/api/humans/notifications/read" ||
    (verb === "GET" && path.startsWith("/api/humans/engagements/"))
  ) return false;
  if (path === "/api/creators/invite/unsubscribe") return false;
  if (path === "/api/creators/library" || path.startsWith("/api/creators/library/")) return false;
  return (
    path === "/api/creator" ||
    path.startsWith("/api/creator/") ||
    path === "/api/humans" ||
    path.startsWith("/api/humans/") ||
    path === "/api/creators" ||
    path.startsWith("/api/creators/")
  );
}
