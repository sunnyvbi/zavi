import { describe, it, expect } from "vitest";
import { classifyClientRequestError, unhandledRouteErrorLog } from "../app";

function bodyParserError(type: string, status: number, ctor: ErrorConstructor = Error) {
  const e = new ctor("boom") as Error & {
    type?: string;
    status?: number;
    statusCode?: number;
  };
  e.type = type;
  e.status = status;
  e.statusCode = status;
  return e;
}

describe("classifyClientRequestError", () => {
  it("oversize body → 413 payload_too_large, and names the corrective action", () => {
    const r = classifyClientRequestError(bodyParserError("entity.too.large", 413));
    expect(r).not.toBeNull();
    expect(r?.status).toBe(413);
    expect(r?.code).toBe("payload_too_large");
    expect(r?.message).toMatch(/shorter/i);
    expect(r?.message).toMatch(/1MB/i);
  });

  it("a 413 without the type tag is still 413 (body-parser sets status either way)", () => {
    const e = new Error("request entity too large") as Error & { status?: number };
    e.status = 413;
    expect(classifyClientRequestError(e)?.status).toBe(413);
  });

  it("malformed JSON still → 400 invalid_json (the A7 guard is unchanged)", () => {
    const r = classifyClientRequestError(
      bodyParserError("entity.parse.failed", 400, SyntaxError),
    );
    expect(r?.status).toBe(400);
    expect(r?.code).toBe("invalid_json");
  });

  it("a bare SyntaxError with status 400 still → 400 invalid_json", () => {
    const e = new SyntaxError("Unexpected token") as SyntaxError & { status?: number };
    e.status = 400;
    expect(classifyClientRequestError(e)?.code).toBe("invalid_json");
  });

  it("a genuine server fault returns null so it stays a logged 5xx", () => {
    expect(classifyClientRequestError(new Error("db exploded"))).toBeNull();
    expect(classifyClientRequestError(bodyParserError("something.else", 500))).toBeNull();
    expect(classifyClientRequestError(new SyntaxError("bad JSON.parse in a service"))).toBeNull();
  });
});

describe("unhandledRouteErrorLog", () => {
  const req = (auth?: { tenant_id: string }) =>
    ({ method: "POST", path: "/api/workspace/autopilot/refine", auth }) as never;

  it("names the tenant whose request failed, so a 5xx can be traced to a workspace", () => {
    const row = unhandledRouteErrorLog(new TypeError("boom"), req({ tenant_id: "b92dcbf1-bac9-457a-af81-0bbe5984339b" }));
    expect(row.tenant_id).toBe("b92dcbf1-bac9-457a-af81-0bbe5984339b");
    expect(row.meta).toEqual({
      http_status: 500,
      method: "POST",
      path: "/api/workspace/autopilot/refine",
      error_class: "TypeError",
    });
  });

  it("logs an unauthenticated failure with no tenant rather than guessing one", () => {
    expect(unhandledRouteErrorLog(new Error("boom"), req()).tenant_id).toBeNull();
  });
});
