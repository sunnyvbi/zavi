
import { describe, it, expect } from "vitest";
import { emailCanRemove, registrableDomain } from "../report";

describe("registrableDomain", () => {
  it.each([
    ["acme.com", "acme.com"],
    ["www.acme.com", "acme.com"],
    ["shop.acme.com", "acme.com"],
    ["a.b.acme.com", "acme.com"],
    ["acme.co.uk", "acme.co.uk"],
    ["shop.acme.co.uk", "acme.co.uk"],
    ["acme.com.au", "acme.com.au"],
    ["alice.github.io", "alice.github.io"],
    ["docs.alice.github.io", "alice.github.io"],
    ["store.myshopify.com", "store.myshopify.com"],
    ["ACME.COM.", "acme.com"],
    ["victim.com.ng", "victim.com.ng"],
    ["shop.victim.com.ng", "victim.com.ng"],
    ["victim.squarespace.com", "victim.squarespace.com"],
    ["blog.victim.substack.com", "victim.substack.com"],
  ])("%s → %s", (host, want) => {
    expect(registrableDomain(host)).toBe(want);
  });
});

describe("emailCanRemove", () => {
  it.each([
    ["anna@acme.com", "acme.com"],
    ["anna@acme.com", "shop.acme.com"],
    ["anna@mail.acme.com", "acme.com"],
    ["Anna@ACME.com", "acme.com"],
    ["owner@acme.co.uk", "shop.acme.co.uk"],
    ["me@alice.github.io", "alice.github.io"],
  ])("%s may remove %s", (email, domain) => {
    expect(emailCanRemove(email, domain)).toBe(true);
  });

  it.each([
    ["anna@gmail.com", "acme.com", "freemail"],
    ["anna@gmail.com", "gmail.com", "freemail never proves a site"],
    ["anna@acme.com.evil.io", "acme.com", "look-alike suffix"],
    ["owner@attacker.com.ng", "victim.com.ng", "sibling under a multi-label public suffix"],
    ["me@bob.github.io", "alice.github.io", "another customer on a shared host"],
    ["employee@squarespace.com", "victim.squarespace.com", "the shared host's own staff"],
    ["employee@wordpress.com", "victim.wordpress.com", "the shared host's own staff"],
    ["anna@notacme.com", "acme.com", "different domain"],
    ["anna@other.co.uk", "acme.co.uk", "same public suffix only"],
    ["staff@github.io", "alice.github.io", "shared host staff"],
    ["bob@github.io", "github.io", "card is a shared host"],
    ["anna@bob.github.io", "alice.github.io", "another customer on the shared host"],
    ["not-an-email", "acme.com", "no @"],
    ["@acme.com", "acme.com", "no local part"],
  ])("%s may NOT remove %s (%s)", (email, domain) => {
    expect(emailCanRemove(email, domain)).toBe(false);
  });
});
