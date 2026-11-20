// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PinBody, pinFields } from "../../actions/organic/blocks/PinFields";
import type { ActionItem } from "../../actions/types";

afterEach(cleanup);

const ZOOMCAR = `TITLE (49 chars):
Weekend Road Trips From Bangalore. Drive Yourself

DESCRIPTION:
Coorg. Ooty. Chikmagalur. Book a self-drive car on Zoomcar.

ALT TEXT:
A winding mountain road

DESTINATION URL:
https://www.zoomcar.in/bangalore
(Add UTM parameters using your tracking convention before uploading)

BOARD: Weekend Road Trips From Bangalore (new board)
BOARD DESCRIPTION: Self-drive road trip ideas from Bangalore.`;

describe("pinFields", () => {
  it("reads the four pin lines from a long upload brief", () => {
    expect(pinFields(ZOOMCAR)).toEqual([
      { label: "Title", value: "Weekend Road Trips From Bangalore. Drive Yourself" },
      { label: "Description", value: "Coorg. Ooty. Chikmagalur. Book a self-drive car on Zoomcar." },
      { label: "Destination", value: "zoomcar.in" },
      { label: "Board", value: "Weekend Road Trips From Bangalore (new board)" },
    ]);
  });

  it("reads the short inline form and ignores lines it does not show", () => {
    expect(pinFields("Title: Car rental delivered to your door from $30/day\nImage: social-1.png\n**Destination:** https://upcar.ai\nBoard: Cheap car rental")).toEqual([
      { label: "Title", value: "Car rental delivered to your door from $30/day" },
      { label: "Destination", value: "upcar.ai" },
      { label: "Board", value: "Cheap car rental" },
    ]);
  });

  it("gives up on copy that is not a pin", () => {
    expect(pinFields("Just a caption with no labels")).toBeNull();
    expect(pinFields("Title: only a title")).toBeNull();
  });
});

describe("PinBody", () => {
  const action = (media?: Record<string, unknown>) => ({
    id: "a1",
    action_type: "image_post",
    channel_slug: "pinterest_organic",
    body: { media, step: { title: "Upload pin", deliverable: { kind: "post", content: "Title: Cheap car rental\nDescription: Book in the app, skip the line.\nDestination: https://upcar.ai" } } },
  }) as unknown as ActionItem;
  const copy = { title: "Upload pin", lead: null, points: [], steps: [], about: null } as never;

  it("shows the rendered pin next to its lines", () => {
    render(<PinBody a={action({ kind: "image", url: "https://cdn.example/pin.png", alt: "A car interior" })} copy={copy} edited={null} />);
    expect(screen.getByRole("img", { name: "A car interior" }).getAttribute("src")).toBe("https://cdn.example/pin.png");
    expect(screen.getByTestId("pin-fields").textContent).toBe("Title: Cheap car rentalDescription: Book in the app, skip the line.Destination: upcar.ai");
  });

  it("shows the lines alone when no image was rendered", () => {
    render(<PinBody a={action()} copy={copy} edited={null} />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByTestId("pin-fields")).toBeTruthy();
  });
});
