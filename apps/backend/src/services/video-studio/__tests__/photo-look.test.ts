import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/anthropic", () => ({ createMessageWithFailover: vi.fn() }));
vi.mock("@/services/tenant-client", () => ({ asTenantId: (t: string) => t, tenantStorage: vi.fn() }));

import { parsePhotoLook } from "../photo-look";

describe("parsePhotoLook", () => {
  it("reads a person and a gender", () => {
    expect(parsePhotoLook('{"has_person": true, "gender": "female"}')).toEqual({ has_person: true, gender: "female" });
  });
  it("drops a gender when there is no person, and an unknown gender becomes null", () => {
    expect(parsePhotoLook('{"has_person": false, "gender": "female"}')).toEqual({ has_person: false, gender: null });
    expect(parsePhotoLook('{"has_person": true, "gender": "other"}')).toEqual({ has_person: true, gender: null });
  });
  it("returns null for anything that is not the answer shape", () => {
    expect(parsePhotoLook("I see a woman")).toBeNull();
    expect(parsePhotoLook('{"gender": "male"}')).toBeNull();
    expect(parsePhotoLook("{broken")).toBeNull();
  });
});
