import { describe, it, expect } from "vitest";
import { appBuildScope, isWholeAppBuildIntent } from "../whole-app-intent";

describe("isWholeAppBuildIntent — server-side whole-app scope classifier", () => {
  it("matches genuine whole-app build asks", () => {
    for (const s of [
      "can you build whole application",
      "build the whole application for me",
      "Build me an entire app from scratch",
      "create a complete SaaS platform",
      "make the whole thing",
      "build an app",
      "build me a marketplace",
      "develop a full product",
      "Summary: user wants to build the entire application.\nUser: can you build whole application",
    ]) {
      expect(isWholeAppBuildIntent(s), s).toBe(true);
    }
  });

  it("does NOT match small/normal engineer asks", () => {
    for (const s of [
      "fix the checkout bug",
      "add a Buy Credits button to the settings page",
      "update the README",
      "the app is crashing on login, can you look",
      "review PR #123",
      "rename the getUser helper",
      "",
    ]) {
      expect(isWholeAppBuildIntent(s), s).toBe(false);
    }
  });

  it("matches a build ask with a few words describing the app before the noun", () => {
    for (const s of [
      "Help me to make a blog posting website.",
      "build me a simple recipe sharing app",
      "create a two-sided freelance marketplace",
    ]) {
      expect(isWholeAppBuildIntent(s), s).toBe(true);
    }
  });

  it("still ignores descriptive words that never reach an app noun", () => {
    for (const s of [
      "make the header sticky on scroll",
      "create a new branch for the fix",
      "build the docs for the api package",
      "create a new product listing",
      "make a new product page",
      "add a product",
      "create a product card for the shoes",
      "make the website header blue",
      "build the app settings section",
      "create a new product category",
      "make a marketplace listing form",
    ]) {
      expect(isWholeAppBuildIntent(s), s).toBe(false);
    }
  });

  it("does NOT treat an edit to an existing site as a whole-app build", () => {
    for (const s of [
      "make the booking website mobile-friendly",
      "Make the booking website mobile-friendly.",
      "make my booking app faster",
      "make our website responsive",
      "make the yoga studio booking website load faster",
      "can you make the website look better on phones?",
      "make me the booking website mobile-friendly",
      "build the booking website a contact form",
      "create my website's footer links",
      "make a website's header sticky",
      "change the booking site colors",
      "update my website's header",
      "redesign the app homepage",
    ]) {
      expect(isWholeAppBuildIntent(s), s).toBe(false);
    }
  });

  it("still matches a bare build of the app with a definite or possessive noun", () => {
    for (const s of [
      "build my app",
      "build the app",
      "build the app for me.",
      "create our website",
      "build me a mobile-friendly booking website",
      "make a booking website for my yoga studio",
    ]) {
      expect(isWholeAppBuildIntent(s), s).toBe(true);
    }
  });

  it("is null/undefined-safe", () => {
    expect(isWholeAppBuildIntent(null)).toBe(false);
    expect(isWholeAppBuildIntent(undefined)).toBe(false);
  });
});


describe("appBuildScope", () => {
  it.each([
    "Build a standalone 3D block-world game that runs in the browser. It is separate from the existing app.",
    "Create a separate inventory application for a different business",
    "Create a separate companion app for my existing website",
    "Build an independent marketplace from scratch",
    "Build a game as a separate product",
    "Build a standalone browser-based multiplayer block-world game",
    "Build a standalone application with a game mode and a settings page",
    "Build a standalone app with a game inside my app",
    "Do not build a game inside my app; instead create a separate inventory application",
  ])("keeps a separate product separate: %s", (intent) => {
    expect(appBuildScope(intent)).toBe("separate_app");
    expect(isWholeAppBuildIntent(intent)).toBe(true);
  });

  it.each([
    "Build a game",
    "Create a complete puzzle game",
    "Build a new game from scratch",
    "Build an application for tracking stock",
  ])("recognises whole builds without choosing a new project: %s", (intent) => {
    expect(appBuildScope(intent)).toBe("whole_app");
  });

  it.each([
    "Fix the controls in the existing game",
    "Add a standalone game to the existing app",
    "Build a game inside the existing application",
    "Build a game inside my app",
    "Build a standalone game from scratch inside my existing app",
    "Build a standalone game widget in my current website",
    "Create a separate game mode in my existing game",
    "Build a standalone game widget from scratch inside the existing website",
    "Make an independent app settings page from scratch",
    "Build the complete game controls from scratch",
    "Do not build a separate game; fix the checkout bug",
    "Do not build a separate game, fix the existing site",
    "Create a separate game settings page",
    "Build a separate product card",
    "Make the existing game faster",
    "Create a game level for the current game",
  ])("keeps edits and components on their existing route: %s", (intent) => {
    expect(appBuildScope(intent)).toBe("existing");
  });

  it("does not treat an explicitly rejected separate project as requested", () => {
    expect(appBuildScope("Build a complete application, not a separate app")).toBe("whole_app");
    expect(appBuildScope("Build a game, not a separate app")).toBe("whole_app");
  });
});

describe("appBuildScope references and explicit Spanish separation", () => {
  it.each([
    "Create a login page for my app",
    "Create a signup form for the app",
    "Create a checkout flow for my marketplace",
    "Build a checkout flow for my marketplace",
    "Create an admin dashboard for the platform",
    "Build an admin dashboard for the platform",
    "Create a separate login page for my app",
    "Create a login page for my mobile app",
    "Build a checkout flow for our rental marketplace",
    "Build the complete settings page of my app from scratch",
    "Create a navigation menu in the current application",
  ])("keeps a reference to the containing app on the edit path: %s", (intent) => {
    expect(appBuildScope(intent)).toBe("existing");
  });

  it.each([
    ["Build a separate app with a login page", "separate_app"],
    ["Build a separate mobile app with a login page", "separate_app"],
    ["Build an all in one app", "whole_app"],
    ["Create a dashboard app for a shop", "whole_app"],
    ["Create a signup form builder app", "whole_app"],
  ])("keeps a real app as the build object: %s", (intent, scope) => {
    expect(appBuildScope(intent)).toBe(scope);
  });

  it.each([
    "Crea una aplicación separada de mi aplicación actual",
    "Construye un sitio web independiente de mi sitio actual",
    "Crear un juego separado de la aplicación actual",
    "Por favor, crea una nueva aplicación independiente",
  ])("recognises an explicit Spanish separate project: %s", (intent) => {
    expect(appBuildScope(intent)).toBe("separate_app");
  });

  it.each([
    "No crees una aplicación separada; cambia el color",
    "No crear un juego separado de la aplicación actual",
    "No quiero crear un juego independiente",
    "Crea un juego independiente desde cero dentro de mi aplicación",
    "Crea una página de inicio separada para mi aplicación",
    "Crea un modo de juego independiente dentro de mi aplicación",
    "Crea un juego independiente dentro de mi aplicación actual",
  ])("does not promote a negation or Spanish component to a separate project: %s", (intent) => {
    expect(appBuildScope(intent)).toBe("existing");
  });
});
