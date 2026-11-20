import { describe, it, expect } from "vitest";
import { isZaviGeneratedHost } from "../write-anchor";

describe("isZaviGeneratedHost", () => {
  it("recognizes the apps we deploy for people", () => {
    expect(isZaviGeneratedHost("dance-ai-6e58e072.onrender.com")).toBe(true);
    expect(isZaviGeneratedHost("ev-charging-management-software-18be.onrender.com")).toBe(true);
    expect(isZaviGeneratedHost("onrender.com")).toBe(true);
  });

  it("recognizes Zavi-issued subdomains and our own site", () => {
    expect(isZaviGeneratedHost("acme.thepraxis.ai")).toBe(true);
    expect(isZaviGeneratedHost("www.zaviagent.com")).toBe(true);
  });

  it("does NOT flag a real customer's own domain — their site IS evidence", () => {
    expect(isZaviGeneratedHost("eclosetapp.com")).toBe(false);
    expect(isZaviGeneratedHost("herafertility.co")).toBe(false);
    expect(isZaviGeneratedHost("www.upcar.ai")).toBe(false);
  });

  it("is not fooled by a lookalike domain a third party could register", () => {
    expect(isZaviGeneratedHost("notonrender.com")).toBe(false);
    expect(isZaviGeneratedHost("myonrender.com")).toBe(false);
    expect(isZaviGeneratedHost("thepraxis.ai.evil.com")).toBe(false);
  });

  it("is case- and www-insensitive", () => {
    expect(isZaviGeneratedHost("WWW.Dance-AI.OnRender.com")).toBe(true);
  });
});
