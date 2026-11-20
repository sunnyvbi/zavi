import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkAuthoredFilm } from "../authored-film";

describe("worked example", () => {
  it("passes the same static gate an authored film must pass", () => {
    const path = join(process.cwd(), "../../packages/launch-video/examples/authored-fernwork.tsx");
    const tsx = readFileSync(path, "utf8");
    const result = checkAuthoredFilm(tsx, 1800);
    expect(result).toEqual({ ok: true });
  });
});
