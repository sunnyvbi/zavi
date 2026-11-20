// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const OWNER = "00000000-0000-4000-8000-000000000001";
const MEMBER = "00000000-0000-4000-8000-000000000002";

const bodies: Record<string, unknown> = {
  "/api/v1/members": {
    members: [
      { user_id: OWNER, email: "owner@acme.com", role: "owner" },
      { user_id: MEMBER, email: "bob@acme.com", role: "member" },
    ],
  },
  "/api/tenant/me/email-members": { disabled_user_ids: [OWNER, MEMBER] },
};
vi.mock("@/lib/api", () => ({
  apiFetch: (path: string) =>
    Promise.resolve({ ok: true, json: () => Promise.resolve(bodies[path] ?? {}) }),
}));

import { EmailAllowlistPanel } from "./EmailAllowlistPanel";

afterEach(cleanup);

describe("EmailAllowlistPanel — owner email is always on", () => {
  it("shows the owner ON and locked, while a member stays switchable", async () => {
    render(<EmailAllowlistPanel canEdit />);
    const owner = await waitFor(() =>
      screen.getByRole("switch", { name: "Email is always on for owner@acme.com (owner)" }),
    );
    expect(owner.getAttribute("aria-checked")).toBe("true");
    expect((owner as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Owners always have email access")).toBeDefined();

    const member = screen.getByRole("switch", { name: "Enable email for bob@acme.com" });
    expect(member.getAttribute("aria-checked")).toBe("false");
    expect((member as HTMLButtonElement).disabled).toBe(false);
  });
});
