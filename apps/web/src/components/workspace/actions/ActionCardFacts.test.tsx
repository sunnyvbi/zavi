// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ActionCardFacts } from "./ActionCardFacts";

afterEach(cleanup);

it("gives long review facts the full card width on phones", () => {
  render(<ActionCardFacts description={<p>A long campaign review with details.</p>} cost="Budget not provided" provenance="Creative source not provided" destination="Meta Ads" />);

  const description = screen.getByTestId("action-description");
  const row = description.parentElement;
  expect(row?.classList.contains("grid-cols-1")).toBe(true);
  expect(row?.classList.contains("sm:grid-cols-ad-facts")).toBe(true);
  expect(row?.querySelector("dt")?.textContent).toBe("What it is");
  expect(description.textContent).toBe("A long campaign review with details.");
});
