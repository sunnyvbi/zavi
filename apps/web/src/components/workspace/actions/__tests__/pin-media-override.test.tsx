// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PinBody } from "../organic/blocks/PinFields";
import { cardCopyOf } from "../card/cardModel";
import { makeAction } from "./fixtures";
afterEach(cleanup);

it.each([true, false])("shows the replacement image beside structured pin fields (existing image: %s)", (hasImage) => {
  const a = makeAction("image_post", { channel_slug: "pinterest_organic", body: { media: hasImage ? { kind: "image", url: "https://example.com/old.png", alt: "Old pin" } : undefined, step: { deliverable: { kind: "post", content: "Title: A useful pin\nDescription: A clear description" } } } });
  render(<PinBody a={a} copy={cardCopyOf(a)} edited={null} mediaOverride={<img src="/replacement.png" alt="Replacement pin" />} />);
  expect(screen.getByRole("img", { name: "Replacement pin" }).getAttribute("src")).toBe("/replacement.png");
  expect(screen.queryByRole("img", { name: "Old pin" })).toBeNull();
  expect(screen.getByText("A useful pin")).toBeTruthy();
  expect(screen.getByText("A clear description")).toBeTruthy();
});

it("keeps the saved image when there is no replacement", () => {
  const a = makeAction("image_post", { channel_slug: "pinterest_organic", body: { media: { kind: "image", url: "https://example.com/saved.png", alt: "Saved pin" }, step: { deliverable: { kind: "post", content: "Title: A useful pin\nDescription: A clear description" } } } });
  render(<PinBody a={a} copy={cardCopyOf(a)} edited={null} />);
  expect(screen.getByRole("img", { name: "Saved pin" }).getAttribute("src")).toBe("https://example.com/saved.png");
});
