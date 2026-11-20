import express, { type RequestHandler } from "express";

export const BUILD_REQUEST_JSON_LIMIT_BYTES = 6 * 1024 * 1024;
const BUILD_REQUEST_ROUTE = /^\/api\/(onboarding\/build-start|workspace\/autopilot\/build-product)\/?$/;

export function buildRequestJson(): RequestHandler {
  const parse = express.json({ limit: BUILD_REQUEST_JSON_LIMIT_BYTES });
  return (req, res, next) => {
    if (req.method === "POST" && BUILD_REQUEST_ROUTE.test(req.path)) return parse(req, res, next);
    return next();
  };
}
