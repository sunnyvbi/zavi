import { describe, it, expect } from "vitest";
import { guardCheck } from "../run";

describe("guardCheck", () => {
  it("passes a check's own result through", async () => {
    const r = await guardCheck("db", async () => ({ name: "db", status: "ok", detail: "fine" }));
    expect(r).toEqual({ name: "db", status: "ok", detail: "fine" });
  });

  it("turns a throw into a fail row for that check, naming the error class only", async () => {
    const err = Object.assign(new Error("User arn:aws:sts::123:assumed-role/x is not authorized"), {
      name: "AccessDeniedException",
    });
    const r = await guardCheck("secrets", async () => {
      throw err;
    });
    expect(r.name).toBe("secrets");
    expect(r.status).toBe("fail");
    expect(r.meta).toEqual({ error_class: "AccessDeniedException" });
    expect(r.detail).not.toContain("arn:aws");
  });
});
