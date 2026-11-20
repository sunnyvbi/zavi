// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { EmailDraft, parseEmailDraft, shortTabLabel } from "../EmailDraft";

afterEach(cleanup);

const DAY3 = "Send: day 3, only if no class booked yet\nSubject: Not sure which class to start with?\nPreview: Tell us a little and we'll point you to one.\n\nHi [first name],\n\nPicking a first class can be the hardest part.";

describe("parseEmailDraft", () => {
  it("lifts the send rule, subject and preview out of the body", () => {
    expect(parseEmailDraft(DAY3)).toEqual({
      send: "day 3, only if no class booked yet",
      subject: "Not sure which class to start with?",
      preview: "Tell us a little and we'll point you to one.",
      body: "Hi [first name],\n\nPicking a first class can be the hardest part.",
    });
  });

  it("reads bolded markdown headers and a preheader line", () => {
    expect(parseEmailDraft("**Subject:** Hello there\nPreheader: quick note\n\nBody")).toMatchObject({ subject: "Hello there", preview: "quick note", body: "Body" });
  });

  it("is not an email without a subject or a body, so the plain box keeps it", () => {
    expect(parseEmailDraft("Hi [first name],\n\nNo subject here.")).toBeNull();
    expect(parseEmailDraft("Subject: Only a subject")).toBeNull();
    expect(parseEmailDraft("Post this on LinkedIn.\nSubject: buried in prose\n\nbody")).toBeNull();
  });
});

describe("EmailDraft", () => {
  it("keeps the email number on the tab and moves the rest to the card", () => {
    expect(shortTabLabel("Email 2: day 3, only if no class booked yet")).toBe("Email 2");
    expect(shortTabLabel("Welcome note")).toBe("Welcome note");
  });

  it("shows the send rule and marks every blank, with no copy button on the card", () => {
    render(<EmailDraft content={DAY3} copyText={DAY3} copyDisabled />);
    expect(screen.getByTestId("email-send").textContent).toBe("day 3, only if no class booked yet");
    expect(screen.getByTestId("email-preview").textContent).toBe("Tell us a little and we'll point you to one.");
    expect(screen.getAllByTestId("email-slot").map((m) => m.textContent)).toEqual(["[first name]"]);
    expect(screen.queryByRole("button", { name: /copy/i })).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();
  });
});

it("fills and highlights merge tags and multiline labelled blanks like the copy path", () => {
  const slot = "[FOUNDER: postal address\n\nrequired before sending]";
  const content = `Subject: Hi {{ first_name }}\n\nVisit ${slot}.`;
  render(<EmailDraft content={content} copyText={content} values={{ "{{ first_name }}": "Maya", [slot]: "42 Main Street" }} active="{{ first_name }}" />);
  expect(screen.getByTestId("email-subject").textContent).toBe("Hi Maya");
  const marks = screen.getAllByTestId("email-slot");
  expect(marks.map((mark) => mark.textContent)).toEqual(["Maya", "42 Main Street"]);
  expect(marks[0].getAttribute("data-active")).toBe("true");
});

it("recognizes subject-leading blanks using the original draft context", () => {
  const content = "Subject: [first name]: your reservation\n\nHello";
  render(<EmailDraft content={content} copyText={content} values={{ "[first name]": "Maya" }} active="[first name]" />);
  expect(screen.getByTestId("email-subject").textContent).toBe("Maya: your reservation");
  expect(screen.getByTestId("email-slot").getAttribute("data-active")).toBe("true");
});
