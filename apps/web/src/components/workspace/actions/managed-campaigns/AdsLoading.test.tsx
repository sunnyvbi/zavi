// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { AdsFormSkeleton, AdsRowsSkeleton, AdsTableSkeletonRows } from "./AdsLoading";

afterEach(() => { cleanup(); });

it("the form skeleton draws one placeholder per field and keeps the loading words for screen readers only", () => {
  render(<AdsFormSkeleton label="Reading the campaign from Meta…" fields={3} />);
  const status = screen.getByRole("status");
  expect(status.textContent).toBe("Reading the campaign from Meta…");
  expect(status.querySelector(".sr-only")?.textContent).toBe("Reading the campaign from Meta…");
  expect(status.querySelectorAll(".animate-pulse")).toHaveLength(6);
});

it("the rows skeleton draws the asked number of rows", () => {
  render(<AdsRowsSkeleton label="Loading campaigns…" rows={2} />);
  expect(screen.getByRole("status").children).toHaveLength(3);
});

it("the table skeleton fills every column of every row", () => {
  render(<table><tbody><AdsTableSkeletonRows columns={5} rows={3} /></tbody></table>);
  const rows = screen.getAllByTestId("ads-table-skeleton-row");
  expect(rows).toHaveLength(3);
  expect(rows[0].querySelectorAll("td")).toHaveLength(5);
});
