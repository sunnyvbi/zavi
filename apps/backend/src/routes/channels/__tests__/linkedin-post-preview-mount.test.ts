import { expect, it } from "vitest";
import { mountRoutes } from "@/routes/index";
import { linkedinListPosts, linkedinPreviewPost, linkedinPrepareAction } from "@/routes/channels/linkedin-ads";
import { authMiddleware } from "@/services/auth/middleware";

it("serves the post preview as a read-only GET behind auth", () => {
  const routes: Array<{ method: string; path: unknown; handlers: unknown[] }> = [];
  const app = new Proxy({}, { get: (_t, method: string) => (path: unknown, ...handlers: unknown[]) => { routes.push({ method, path, handlers }); } });
  mountRoutes(app as never);
  const preview = routes.filter(r => r.handlers.includes(linkedinPreviewPost));
  expect(preview).toEqual([{ method: "get", path: "/api/channels/linkedin_ads/actions/:actionId/post-preview", handlers: [authMiddleware, linkedinPreviewPost] }]);
  expect(routes.some(r => r.handlers.includes(linkedinPrepareAction))).toBe(true);
});

it("serves the post list as a read-only GET behind auth", () => {
  const routes: Array<{ method: string; path: unknown; handlers: unknown[] }> = [];
  const app = new Proxy({}, { get: (_t, method: string) => (path: unknown, ...handlers: unknown[]) => { routes.push({ method, path, handlers }); } });
  mountRoutes(app as never);
  expect(routes.filter(r => r.handlers.includes(linkedinListPosts))).toEqual([{ method: "get", path: "/api/channels/linkedin_ads/actions/:actionId/posts", handlers: [authMiddleware, linkedinListPosts] }]);
});
