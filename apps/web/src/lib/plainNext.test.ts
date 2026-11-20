import { describe, it, expect } from "vitest";
import { isCreatorPath, plainNext } from "./safe-next";
import { landingFor } from "./creator/api";

const REJECTED = [
  "/creator/..%2fworkspace",
  "/creator/%",
  "/workspace%2F..%2Fcreator",
  "/creators/apply%2F..%2F..%2Fworkspace",
  "/workspace/../creator",
  "/workspace/%2e%2e/creator",
  "/creator/%2e%2e/workspace",
  "/creator/./jobs",
  "//evil.example",
  "/\\evil.example",
  "/creator//jobs",
  "https://evil.example/creator",
  "creator",
];

describe("plainNext", () => {
  it.each(REJECTED)("%s is not a plain path (no next)", (raw) => {
    expect(plainNext(raw)).toBeNull();
  });
  it.each([
    "/creator",
    "/creator/jobs/o1?x=1#y",
    "/creators/apply?step=make",
    "/tools?use=abc",
    "/workspace",
    "/creator/jobs?q=a%20b",
    "/tools?ref=https://example.com",
  ])(
    "%s is accepted as is",
    (raw) => {
      expect(plainNext(raw)).toBe(raw);
    },
  );
});

describe("final destination (landingFor)", () => {
  it.each(REJECTED)("a creator with %s lands on /creator", (raw) => {
    expect(landingFor("/creator", raw)).toBe("/creator");
  });
  it.each(REJECTED)("a company account with %s lands on /workspace", (raw) => {
    expect(landingFor("/workspace", raw)).toBe("/workspace");
  });
  it("a creator follows a plain creator path; a company never does", () => {
    expect(landingFor("/creator", "/creator/jobs/o1")).toBe("/creator/jobs/o1");
    expect(landingFor("/creator", "/creators/apply?step=make")).toBe("/creators/apply?step=make");
    expect(landingFor("/creator", "/tools")).toBe("/creator");
    expect(landingFor("/workspace", "/creator")).toBe("/workspace");
    expect(isCreatorPath("/creators/applyx")).toBe(false);
  });
});
