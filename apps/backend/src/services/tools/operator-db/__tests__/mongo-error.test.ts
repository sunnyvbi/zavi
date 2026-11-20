
import { describe, expect, it } from "vitest";
import {
  describeMongoError,
  isAgentFixableMongoError,
  rethrowMongoAsRecoverable,
} from "../mongo-error";
import { ExpectedToolError } from "@/services/tools/types";

const serverError = (message: string, code?: number) =>
  Object.assign(new Error(message), { name: "MongoServerError", ...(code ? { code } : {}) });

describe("isAgentFixableMongoError", () => {
  it("treats a rejected pipeline as the model's to fix", () => {
    expect(
      isAgentFixableMongoError(
        serverError("The argument to $size must be an array, but was of type: missing"),
      ),
    ).toBe(true);
    expect(isAgentFixableMongoError(serverError("Unrecognized expression '$dateDif'"))).toBe(true);
  });

  it("leaves an Atlas authorization failure fatal, however it is spelled", () => {
    expect(isAgentFixableMongoError(serverError("(AtlasError) not authorized on app to execute command", 8000))).toBe(false);
    expect(
      isAgentFixableMongoError(serverError("(AtlasError) unknown top level operator: $nope", 8000)),
    ).toBe(true);
    expect(isAgentFixableMongoError(serverError("not authorized on payments to execute find", 13))).toBe(false);
    expect(isAgentFixableMongoError(serverError("command requires authentication"))).toBe(false);
    expect(
      isAgentFixableMongoError(serverError("unknown top level operator: $unauthorized")),
    ).toBe(true);
    expect(isAgentFixableMongoError(serverError("(AtlasError) Unauthorized", 8000))).toBe(false);
    expect(isAgentFixableMongoError(serverError("Unauthorized"))).toBe(false);
    expect(
      isAgentFixableMongoError(
        Object.assign(new Error("denied"), { name: "MongoServerError", codeName: "Unauthorized" }),
      ),
    ).toBe(false);
  });

  it("leaves an interrupted operation fatal — retrying the pipeline will not help", () => {
    for (const code of [11600, 11601, 11602]) {
      expect(isAgentFixableMongoError(serverError("interrupted", code)), String(code)).toBe(false);
    }
  });

  it("leaves auth, reachability and timeout alone", () => {
    expect(isAgentFixableMongoError(serverError("not authorized on db", 13))).toBe(false);
    expect(isAgentFixableMongoError(serverError("Authentication failed", 18))).toBe(false);
    expect(isAgentFixableMongoError(serverError("operation exceeded time limit", 50))).toBe(false);
    expect(
      isAgentFixableMongoError(Object.assign(new Error("no primary"), { name: "MongoServerSelectionError" })),
    ).toBe(false);
    expect(
      isAgentFixableMongoError(Object.assign(new Error("socket"), { name: "MongoNetworkError" })),
    ).toBe(false);
  });

  it("does not read a ROW VALUE as an auth failure, in either spelling", () => {
    expect(
      isAgentFixableMongoError(
        serverError("Failed to parse objectId 'Unauthorized' in $convert with no onError value"),
      ),
    ).toBe(true);
    expect(
      isAgentFixableMongoError(serverError("Failed to parse objectId 'no permission' in $toObjectId")),
    ).toBe(true);
    expect(
      isAgentFixableMongoError(
        serverError("Failed to parse objectId 'not authorized on prod' in $convert"),
      ),
    ).toBe(true);
    expect(
      isAgentFixableMongoError(serverError(`$convert failed on "authentication failed" input`)),
    ).toBe(true);
    expect(
      isAgentFixableMongoError(
        serverError("Failed to parse objectId 'Ravi's not authorized on prod' in $convert"),
      ),
    ).toBe(true);
    expect(
      isAgentFixableMongoError(
        serverError("Failed to parse objectId 'works in $bar but not authorized on prod' in $convert"),
      ),
    ).toBe(true);
    expect(
      isAgentFixableMongoError(
        serverError(
          "Failed to parse objectId 'a in $x not authorized' in $convert with no onError value",
        ),
      ),
    ).toBe(true);
    expect(
      isAgentFixableMongoError(
        serverError(
          "Failed to parse objectId 'works in $bar, but not authorized on prod' in $convert with no onError value",
        ),
      ),
    ).toBe(true);
    expect(
      isAgentFixableMongoError(
        serverError("Failed to convert 'x in $y) not authorized on prod' in $toObjectId"),
      ),
    ).toBe(true);
  });

  it("still catches a real auth verdict, which is the WHOLE message", () => {
    expect(isAgentFixableMongoError(serverError("(AtlasError) Unauthorized", 8000))).toBe(false);
    expect(isAgentFixableMongoError(serverError("Unauthorized"))).toBe(false);
    expect(isAgentFixableMongoError(serverError("  unauthorized. "))).toBe(false);
    expect(isAgentFixableMongoError(serverError("not authorized on app to execute command"))).toBe(false);
    expect(isAgentFixableMongoError(serverError("user has no permission to execute find"))).toBe(false);
    expect(
      isAgentFixableMongoError(serverError("command find requires authentication")),
    ).toBe(false);
    expect(
      isAgentFixableMongoError(serverError("not authorized on app to execute command { find: 1 }")),
    ).toBe(false);
  });

  it("does not read a ROW VALUE as an auth failure", () => {
    expect(
      isAgentFixableMongoError(serverError("Failed to parse objectId 'no permission' in $toObjectId")),
    ).toBe(true);
    expect(isAgentFixableMongoError(serverError("user has no permission to execute find"))).toBe(false);
  });

  it("does not claim a plain Error or a non-object", () => {
    expect(isAgentFixableMongoError(new Error("boom"))).toBe(false);
    expect(isAgentFixableMongoError(null)).toBe(false);
    expect(isAgentFixableMongoError("MongoServerError")).toBe(false);
  });
});

describe("describeMongoError", () => {
  it("keeps the operator and the reason, which is all the model needs to fix it", () => {
    const out = describeMongoError(
      serverError("The argument to $size must be an array, but was of type: missing"),
    );
    expect(out).toContain("$size");
    expect(out).toContain("must be an array");
  });

  it("never copies an UNQUOTED row value out of the message", () => {
    const out = describeMongoError(
      serverError("$range requires a non-negative bound, found value: 4406400001"),
    );
    expect(out).not.toContain("4406400001");
    expect(out).toContain("$range");
  });

  it("never copies a quoted literal out either", () => {
    const out = describeMongoError(
      serverError(`$match failed on { email: "ada@example.com" } — unknown operator '$eqq'`),
    );
    expect(out).not.toContain("ada@example.com");
    expect(out).not.toContain("$eqq".replace("$eqq", "ada"));
    expect(out).toContain("$match");
  });

  it("does not echo a $-prefixed ROW VALUE as though it were an operator", () => {
    const out = describeMongoError(
      serverError("$range requires a numeric bound, found value: $AdaLovelaceVIP"),
    );
    expect(out).not.toContain("AdaLovelaceVIP");
    expect(out).toContain("$range");
  });

  it("distinguishes an arity mistake from a divisor mistake", () => {
    expect(describeMongoError(serverError("$divide takes exactly 2 arguments, 1 were passed in"))).toContain(
      "wrong number of arguments",
    );
    expect(describeMongoError(serverError("can't $divide by zero"))).toContain("divisor");
  });

  it("says plainly when it is withholding wording it does not recognise", () => {
    const out = describeMongoError(serverError("something entirely novel about 1234567 rows"));
    expect(out).not.toContain("1234567");
    expect(out).toMatch(/withheld/);
  });

  it("does not name an operator the read grammar bans", () => {
    expect(describeMongoError(serverError("$where is not allowed"))).not.toContain("$where");
  });

  it("keeps the operator hint for date and string operators the grammar allows", () => {
    for (const op of ["$dateFromParts", "$dayOfWeek", "$indexOfCP", "$sortArray"]) {
      expect(describeMongoError(serverError(`${op} failed: must be an array`)), op).toContain(op);
    }
  });

  it("names the codeName when the driver gives one", () => {
    const e = Object.assign(new Error("boom on $group"), {
      name: "MongoServerError",
      codeName: "Location40323",
    });
    expect(describeMongoError(e)).toContain("Location40323");
  });
});

describe("rethrowMongoAsRecoverable", () => {
  it("hands the model a recoverable error naming the collection", () => {
    try {
      rethrowMongoAsRecoverable(serverError("The argument to $size must be an array"), "time_entries");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ExpectedToolError);
      const err = e as ExpectedToolError;
      expect(err.code).toBe("operator_db_read_failed");
      expect(err.message).toContain("time_entries");
      expect(String(err.meta?.db_message)).toContain("$size");
    }
  });

  it("rethrows a connection failure untouched", () => {
    const original = Object.assign(new Error("no primary"), { name: "MongoServerSelectionError" });
    try {
      rethrowMongoAsRecoverable(original, "shipments");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBe(original);
      expect(e).not.toBeInstanceOf(ExpectedToolError);
    }
  });
});
