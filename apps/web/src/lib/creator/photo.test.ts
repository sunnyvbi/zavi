import { describe, it, expect } from "vitest";
import { photoFileError } from "./photo";

describe("photoFileError", () => {
  it("accepts JPG, PNG and WebP up to 5 MB", () => {
    for (const type of ["image/jpeg", "image/png", "image/webp"]) expect(photoFileError({ type, size: 5 * 1024 * 1024 })).toBeNull();
  });
  it("refuses other types and anything over 5 MB", () => {
    expect(photoFileError({ type: "image/gif", size: 10 })).toMatch(/JPG, PNG or WebP/);
    expect(photoFileError({ type: "video/mp4", size: 10 })).toMatch(/JPG, PNG or WebP/);
    expect(photoFileError({ type: "image/png", size: 5 * 1024 * 1024 + 1 })).toBe("Photos can be up to 5 MB.");
  });
});
