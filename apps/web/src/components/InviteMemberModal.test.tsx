// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { InviteMemberModal } from "./InviteMemberModal";
import { apiFetch } from "@/lib/api";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));

afterEach(cleanup);

describe("InviteMemberModal appearance", () => {
  it("uses a dark-safe scrim, quiet role selection, and a legible primary hover", () => {
    render(<InviteMemberModal open onClose={() => {}} onInvited={() => {}} />);

    const dialog = screen.getByRole("dialog", { name: "Invite a teammate" });
    expect(dialog.parentElement).toBe(document.body);
    expect(dialog.className).toContain("dialog-scrim");
    expect(dialog.className).not.toContain("bg-ink/40");

    const panel = dialog.firstElementChild as HTMLElement;
    expect(panel.className).toContain("bg-cream");
    expect(panel.className).not.toContain("bg-white");

    expect(screen.getByLabelText("Email").getAttribute("autocomplete")).toBe(
      "off",
    );
    expect(document.activeElement).toBe(screen.getByLabelText("Email"));

    const selectedRole = screen
      .getByText("Member")
      .closest("label") as HTMLElement;
    expect(selectedRole.className).toContain("bg-bone/60");
    expect(selectedRole.className).not.toContain("0px_0px_0px_4px_#f0f0f0");

    expect(panel.className).toContain("team-dialog-enter");

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "teammate@example.com" },
    });
    const submit = screen.getByRole("button", {
      name: "Send Invite",
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    expect(submit.className).toContain("invite-primary-action");
    expect(submit.className).not.toContain("enabled:hover:bg-inkSoft");
    expect(submit.className).not.toContain("enabled:bg-[#0e0f11]");

    const styles = readFileSync(resolve("src/app/globals.css"), "utf8");
    expect(styles).toMatch(
      /\.team-surface-enter,[\s\S]*?animation:\s*team-surface-enter[^;]*backwards;/,
    );
    expect(styles).not.toMatch(
      /\.team-surface-enter,[\s\S]*?animation:\s*team-surface-enter[^;]*both;/,
    );
    expect(styles).toMatch(
      /html\.dark \.workspace-shell \.invite-primary-action:not\(:disabled\):hover \{\s*background-color: rgb\(var\(--c-dark-strong\)\) !important;/,
    );
    expect(styles).not.toMatch(
      /invite-primary-action:not\(:disabled\):hover[^}]*background-color:\s*#fff/i,
    );
  });
});

describe("InviteMemberModal seat cap", () => {
  it("turns the seat-cap refusal into a plans step instead of a dead Send Invite", async () => {
    window.location.hash = "";
    const message = "Your Free plan has 1 seat, and it's yours. Upgrade your plan to invite teammates.";
    vi.mocked(apiFetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "seat_cap_exceeded", message } }), { status: 403 }),
    );
    const onClose = vi.fn();
    const onInvited = vi.fn();
    render(<InviteMemberModal open onClose={onClose} onInvited={onInvited} />);

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "teammate@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send Invite" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(message);
    expect(alert.className).not.toContain("rose");
    expect(screen.queryByRole("button", { name: "Send Invite" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "See plans" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onInvited).not.toHaveBeenCalled();
    expect(apiFetch).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(window.location.hash).toBe("#billing-plans"));
  });

  it("keeps the Role legend off a fieldset border so the divider never strikes through it", () => {
    render(<InviteMemberModal open onClose={() => {}} onInvited={() => {}} />);
    const fieldset = screen.getByText("Role").closest("fieldset") as HTMLElement;
    expect(fieldset.className).not.toMatch(/border/);
    expect((fieldset.parentElement as HTMLElement).className).toContain("border-t");
  });
});

describe("InviteMemberModal error scroll", () => {
  it("scrolls the padded wrapper into view so the seat-cap notice clears the footer by 20px", async () => {
    const scrolled: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      vi.mocked(apiFetch).mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { code: "seat_cap_exceeded", message: "Your Free plan has 1 seat, and it's yours." } }),
          { status: 403 },
        ),
      );
      render(<InviteMemberModal open onClose={() => {}} onInvited={() => {}} />);
      fireEvent.change(screen.getByLabelText("Email"), { target: { value: "teammate@example.com" } });
      fireEvent.click(screen.getByRole("button", { name: "Send Invite" }));

      const alert = await screen.findByRole("alert");
      await waitFor(() => expect(scrolled.length).toBeGreaterThan(0));
      const target = scrolled[scrolled.length - 1] as HTMLElement;
      expect(target).not.toBe(alert);
      expect(target.contains(alert)).toBe(true);
      expect(target.className.split(/\s+/)).toContain("pb-5");
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});
