
import type { Request, Response, NextFunction } from "express";
import type { JWTPayload } from "jose";
import {
  verifyJwt,
  readBearerToken,
  customerJwksUrl,
  customerExpectedIssuer,
} from "./jwt";
import { serviceClient } from "@/services/supabase";
import { isActiveStaffUser } from "@/services/auth/staff-model-access";

export type StaffSession = {
  user_id: string;
  email: string;
};

declare module "express-serve-static-core" {
  interface Request {
    staff?: StaffSession;
  }
}

type StaffEnv = {
  jwksUrl: string;
  expectedIssuer: string;
  expectedAudience: string;
};

let _env: StaffEnv | null = null;

function staffEnv(): StaffEnv {
  if (_env) return _env;
  const jwksUrl = customerJwksUrl();
  const expectedIssuer = customerExpectedIssuer();
  const expectedAudience = "authenticated";
  _env = { jwksUrl, expectedIssuer, expectedAudience };
  return _env;
}

export function _clearStaffEnvForTests(): void {
  _env = null;
}

function reject(res: Response, code: string, message: string): null {
  res.status(401).json({ error: { code, message } });
  return null;
}

function recordAccess(args: {
  staff_user_id: string | null;
  email: string | null;
  route: string;
  ip: string | null;
  ua: string | null;
}): void {
  void (async () => {
    try {
      const { error } = await serviceClient().from("staff_access_log").insert({
        staff_user_id: args.staff_user_id,
        email: args.email,
        route: args.route,
        ip: args.ip,
        ua: args.ua,
      });
      if (error) {
        // eslint-disable-next-line no-console
        console.error(
          `staff-middleware: audit insert failed: ${error.message}`,
        );
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(
        `staff-middleware: audit insert threw: ${(e as Error).message}`,
      );
    }
  })();
}

function reqIp(req: Request): string | null {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) {
    return fwd.split(",")[0].trim();
  }
  if (Array.isArray(fwd) && fwd.length > 0) return fwd[0];
  return req.ip ?? null;
}

function reqUa(req: Request): string | null {
  const ua = req.headers["user-agent"];
  return typeof ua === "string" ? ua : null;
}

function reqRoute(req: Request): string {
  return req.originalUrl ?? `${req.method} ${req.path}`;
}

export async function requireStaff(req: Request, res: Response): Promise<StaffSession | null> {
  const route = reqRoute(req);
  const ip = reqIp(req);
  const ua = reqUa(req);

  const token = readBearerToken(req);
  if (!token) {
    recordAccess({ staff_user_id: null, email: null, route, ip, ua });
    return reject(res, "unauthenticated", "Missing Bearer token.");
  }

  let env: StaffEnv;
  try {
    env = staffEnv();
  } catch (e) {
    recordAccess({ staff_user_id: null, email: null, route, ip, ua });
    res
      .status(500)
      .json({ error: { code: "staff_misconfigured", message: (e as Error).message } });
    return null;
  }

  let payload: JWTPayload;
  try {
    payload = await verifyJwt({
      token,
      jwksUrl: env.jwksUrl,
      expectedIssuer: env.expectedIssuer,
      expectedAudience: env.expectedAudience,
    });
  } catch {
    recordAccess({ staff_user_id: null, email: null, route, ip, ua });
    return reject(res, "invalid_jwt", "Bad signature, expired, or wrong issuer/audience.");
  }

  const sub = typeof payload.sub === "string" ? payload.sub.trim() : "";
  if (!sub) {
    recordAccess({ staff_user_id: null, email: null, route, ip, ua });
    return reject(res, "invalid_jwt", "JWT has no sub claim.");
  }

  const rawEmail =
    typeof payload.email === "string" ? payload.email : null;
  if (!rawEmail) {
    recordAccess({ staff_user_id: sub, email: null, route, ip, ua });
    return reject(res, "invalid_jwt", "JWT has no email claim.");
  }
  const email = rawEmail.trim().toLowerCase();

  let activeStaff = false;
  try {
    activeStaff = await isActiveStaffUser(serviceClient(), sub);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(
      `staff-middleware: staff_users check failed: ${(e as Error).message}`,
    );
    recordAccess({ staff_user_id: sub, email, route, ip, ua });
    res.status(503).json({
      error: {
        code: "staff_check_unavailable",
        message: "Could not verify staff membership (transient). Try again.",
      },
    });
    return null;
  }

  if (!activeStaff) {
    recordAccess({ staff_user_id: sub, email, route, ip, ua });
    return reject(res, "not_staff", "No active staff_users grant for this account.");
  }

  const session: StaffSession = { user_id: sub, email };
  req.staff = session;
  recordAccess({ staff_user_id: sub, email, route, ip, ua });
  return session;
}

export function assertStaff(req: Request): StaffSession {
  if (!req.staff) {
    throw new Error("assertStaff: req.staff missing — handler not mounted under requireStaff guard");
  }
  return req.staff;
}

export function staffMiddleware() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const session = await requireStaff(req, res);
    if (!session) return;
    next();
  };
}
