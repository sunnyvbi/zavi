import { describe, it, expect } from "vitest";
import { isAppEditIntent, isDestructiveDataEdit, isSiteChatEditIntent } from "../app-edit-intent";

describe("isSiteChatEditIntent: a change typed in ONE site's Build chat", () => {
  it("reads imperative changes with no UI noun as edits (QA 2026-10-02 S5)", () => {
    for (const s of [
      "Add a gluten-free badge next to the sourdough",
      "remove the phone field and delete phone data",
      "Remove the phone field from the orders form and delete the phone data",
      "please add a vegan option to the menu items",
      "can you swap the photo of the croissant",
      "Rename 'Sourdough loaf' to 'Country loaf'",
      "add an opening hours line under the address",
      "Put our opening hours above the phone field",
      "I want the phone field gone",
      "The phone field should be removed",
      "Let's show prices in euros",
      "Can you add a map to the contact page?",
      "Could you put our hours above the phone field?",
    ]) {
      expect(isSiteChatEditIntent(s), s).toBe(true);
    }
    expect(isAppEditIntent("Add a gluten-free badge next to the sourdough")).toBe(false);
    expect(isAppEditIntent("remove the phone field and delete phone data")).toBe(false);
  });

  it("keeps questions and asks for things that are not the site on the chat", () => {
    for (const s of [
      "How many orders came in this week?",
      "What does the phone field do?",
      "Draft a short update for investors",
      "Make me a list of everyone who ordered sourdough",
      "Create an Instagram post about the gluten-free loaf",
      "Write a newsletter about our new hours",
      "thanks!",
      "I want to know how sales went",
      "We need more customers",
      "the phone field works now?",
      "Let's discuss the latest orders",
      "Use your judgement on what to do next",
      "",
    ]) {
      expect(isSiteChatEditIntent(s), s).toBe(false);
    }
  });

  it("is a superset of the general classifier", () => {
    for (const s of ["Change the hero headline to Fresh every morning", "make the header blue"]) {
      expect(isAppEditIntent(s)).toBe(true);
      expect(isSiteChatEditIntent(s)).toBe(true);
    }
  });
});

describe("isDestructiveDataEdit: asks to delete stored data", () => {
  it("catches deleting data, entries, columns or collections", () => {
    for (const s of [
      "remove the phone field and delete phone data",
      "delete all the orders older than a month",
      "wipe the signups table",
      "drop the phone column",
      "clear out the old bookings",
      "the test entries should be deleted",
    ]) {
      expect(isDestructiveDataEdit(s), s).toBe(true);
    }
  });

  it("leaves visible-only removals and additions alone", () => {
    for (const s of [
      "Remove the phone field from the form",
      "Add a gluten-free badge next to the sourdough",
      "delete the second paragraph on the about page",
      "remove the banner",
    ]) {
      expect(isDestructiveDataEdit(s), s).toBe(false);
    }
  });
});
