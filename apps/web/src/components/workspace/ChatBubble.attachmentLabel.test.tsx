// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ChatBubble } from "./ChatBubble";

afterEach(cleanup);

describe("ChatBubble attachment label", () => {
  it("labels a stored .txt doc as TEXT", () => {
    render(<ChatBubble role="user" text="see notes" attachments={[{ path: "t/abc.txt", kind: "doc" }]} />);
    expect(screen.getByText("TEXT")).toBeTruthy();
    expect(screen.queryByText("TXT")).toBeNull();
  });

  it("keeps other extensions as-is", () => {
    render(<ChatBubble role="user" text="see deck" attachments={[{ path: "t/abc.pdf", kind: "doc" }]} />);
    expect(screen.getByText("PDF")).toBeTruthy();
  });
});
