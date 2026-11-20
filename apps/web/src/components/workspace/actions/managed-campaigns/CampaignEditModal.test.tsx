// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CampaignEditModal } from "./CampaignEditModal";

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(cleanup);

it("keeps the submit status live region mounted as its reason changes", () => {
  const base = {
    slug: "google_ads",
    title: "Edit campaign",
    subtitle: "Campaign settings",
    busy: false,
    formId: "edit-form",
    cancelLabel: "Cancel",
    onClose: () => undefined,
    children: <form id="edit-form" />,
  };
  const { rerender } = render(<CampaignEditModal {...base} submit={{ label: "Save", disabled: true, reason: "" }} />);
  const status = screen.getByRole("status");
  expect(status.className).toContain("sr-only");
  rerender(<CampaignEditModal {...base} submit={{ label: "Save", disabled: true, reason: "No changes to save." }} />);
  expect(screen.getByRole("status")).toBe(status);
  expect(status.className).not.toContain("sr-only");
  expect(status.textContent).toBe("No changes to save.");
});

it("while saving, shows only the Saving button: no Cancel to press", () => {
  const base = { slug: "google_ads", title: "Edit campaign", subtitle: "Campaign settings", formId: "edit-form", onClose: () => undefined, children: <form id="edit-form" />, submit: { label: "Save", disabled: false, reason: "Saving changes the live campaign in Google Ads now." } };
  const { rerender } = render(<CampaignEditModal {...base} busy={false} />);
  expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Save" }).getAttribute("aria-busy")).toBe("false");
  rerender(<CampaignEditModal {...base} busy />);
  expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  const saving = screen.getByRole("button", { name: "Saving…" }) as HTMLButtonElement;
  expect(saving.disabled).toBe(true);
  expect(saving.getAttribute("aria-busy")).toBe("true");
});
