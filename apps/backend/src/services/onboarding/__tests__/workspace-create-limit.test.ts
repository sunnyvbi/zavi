import { describe, it, expect, beforeEach } from "vitest";
import { reserveWorkspaceSlot, _resetWorkspaceCreateLimit } from "../workspace-create-limit";

const T0 = 1_000_000_000;
const HOUR = 60 * 60 * 1000;

describe("workspace create limit (per IP)", () => {
  beforeEach(() => _resetWorkspaceCreateLimit());

  it("allows 3 new workspaces per IP per hour, then refuses, then allows after the hour", () => {
    for (let i = 0; i < 3; i++) reserveWorkspaceSlot("203.0.113.7", T0)!.commit(`t${i}`);
    expect(reserveWorkspaceSlot("203.0.113.7", T0)).toBeNull();
    expect(reserveWorkspaceSlot("203.0.113.7", T0 + HOUR)).not.toBeNull();
    expect(reserveWorkspaceSlot("192.0.2.1", T0)).not.toBeNull();
  });

  it("parallel requests cannot all pass: reservations count before creation finishes", () => {
    const slots = Array.from({ length: 10 }, () => reserveWorkspaceSlot("203.0.113.8", T0));
    expect(slots.filter(Boolean)).toHaveLength(3);
  });

  it("a failed creation releases its slot; a retried workspace counts once", () => {
    reserveWorkspaceSlot("203.0.113.9", T0)!.release();
    reserveWorkspaceSlot("203.0.113.9", T0)!.commit("same");
    reserveWorkspaceSlot("203.0.113.9", T0)!.commit("same");
    expect(reserveWorkspaceSlot("203.0.113.9", T0)).not.toBeNull();
  });

  it("never blocks when the IP is unknown", () => {
    for (let i = 0; i < 10; i++) expect(reserveWorkspaceSlot(undefined, T0)).not.toBeNull();
  });
});
