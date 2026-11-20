import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import * as envelope from "@/services/approvals/approval-envelope";

const SRC = join(__dirname, "..", "..", "..");
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === "__tests__" || f === "node_modules" ? [] : files(p);
    return /\.ts$/.test(f) && !/\.test\.ts$/.test(f) ? [p] : [];
  });
}

describe("approval envelope writers", () => {
  it("only approvals/approval-envelope.ts calls set_approval_envelope / claim_approval_envelope", () => {
    expect(typeof envelope.setApprovalEnvelope).toBe("function");
    const callers = files(SRC)
      .filter((f) => /["'](set|claim)_approval_envelope["']/.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f))
      .filter((f) => f !== "services/tenant-client.ts");
    expect(callers).toEqual(["services/approvals/approval-envelope.ts"]);
  });
});
