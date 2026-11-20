import { describe, expect, it } from "vitest";
import { scopeKind } from "@/services/tenant-client";

describe("invite tables are registered with the right scope", () => {
  it("creator_invite_messages is tenant-scoped; creator_invites stays global", () => {
    expect(scopeKind("creator_invite_messages")).toBe("tenant_id");
    expect(scopeKind("creator_invites")).toBe("global");
  });
});
