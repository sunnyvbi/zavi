
import { describe, it, expect } from "vitest";
import { isHttpRoutePath } from "@/agents/engineer/route-detect";

describe("isHttpRoutePath", () => {
  it("true for routes/ paths", () => {
    expect(isHttpRoutePath("apps/backend/src/routes/agents/chat-send.ts")).toBe(true);
  });

  it("true for *Controller.ts", () => {
    expect(isHttpRoutePath("src/controllers/WidgetController.ts")).toBe(true);
  });

  it("true for a *Router.ts file", () => {
    expect(isHttpRoutePath("src/api/widgetRouter.ts")).toBe(true);
  });

  it("true for a controllers/ or handlers/ dir", () => {
    expect(isHttpRoutePath("src/handlers/foo.ts")).toBe(true);
  });

  it("true for Next.js app/api/** route", () => {
    expect(isHttpRoutePath("app/api/widgets/route.ts")).toBe(true);
    expect(isHttpRoutePath("src/pages/api/widgets.ts")).toBe(true);
  });

  it("true for a Next app-router route.ts", () => {
    expect(isHttpRoutePath("app/dashboard/route.ts")).toBe(true);
  });

  it("false for lib/ and a plain service file without route markers", () => {
    expect(isHttpRoutePath("apps/backend/src/lib/util.ts")).toBe(false);
    expect(isHttpRoutePath("apps/backend/src/services/foo.ts")).toBe(false);
  });

  it("false for a test file even under routes/", () => {
    expect(isHttpRoutePath("apps/backend/src/routes/__tests__/foo.test.ts")).toBe(false);
    expect(isHttpRoutePath("src/routes/foo.spec.ts")).toBe(false);
  });

  it("false / no-throw for non-string", () => {
    // @ts-expect-error defensive: non-string never throws
    expect(isHttpRoutePath(undefined)).toBe(false);
  });
});
