import { describe, it, expect } from "vitest";
import { isRawPinterestWrite } from "../raw-write";

describe("isRawPinterestWrite", () => {
  it.each(["PINTEREST_CREATE_PIN", "PINTEREST_DELETE_PIN", "PINTEREST_DELETE_BOARD", "PINTEREST_UPDATE_BOARD", "PINTEREST_CREATE_BOARD", "pinterest_create_pin"])(
    "%s is a raw write",
    (slug) => expect(isRawPinterestWrite(slug)).toBe(true),
  );
  it.each(["PINTEREST_LIST_BOARDS", "PINTEREST_GET_PROFILE", "PINTEREST_GET_TOP_PINS", "PINTEREST_LIST_PINS"])(
    "%s is a read",
    (slug) => expect(isRawPinterestWrite(slug)).toBe(false),
  );
  it("goes by the toolkit the catalog names when the slug lacks the prefix", () => {
    expect(isRawPinterestWrite("SAVE_PIN", "pinterest")).toBe(true);
    expect(isRawPinterestWrite("SAVE_PIN", "reddit")).toBe(false);
  });
  it("leaves other toolkits alone", () => {
    expect(isRawPinterestWrite("REDDIT_CREATE_POST")).toBe(false);
    expect(isRawPinterestWrite("TIKTOK_ADS_UPLOAD_IMAGE", "tiktok_ads")).toBe(false);
  });
});
