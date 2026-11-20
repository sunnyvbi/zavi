import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { creatorMarketplaceUnavailable } from "../app";

function response() {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
}

describe("creator marketplace process-boundary gate", () => {
  it.each([
    ["GET", "/api/creator/home"],
    ["PATCH", "/api/creator/profile"],
    ["POST", "/api/humans/orders"],
    ["POST", "/api/creator/signup"],
    ["GET", "/api/creator/affiliate"],
  ])("passes %s %s to the real handler while the marketplace is on", (method, path) => {
    const res = response();
    const next = vi.fn();
    creatorMarketplaceUnavailable(
      { path, method } as Pick<Request, "path" | "method">,
      res as unknown as Pick<Response, "status" | "json">,
      next as NextFunction,
    );
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });
});
