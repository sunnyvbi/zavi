// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

import { CompanyFactsPanel } from "./CompanyFactsPanel";

const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

let facts: { resolve: (r: Response) => void };

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation((url: string) => {
    if (url === "/api/connectors/company-facts") {
      return new Promise<Response>((resolve) => {
        facts = { resolve };
      });
    }
    return Promise.resolve(json({}));
  });
});
afterEach(cleanup);

const card = () => document.getElementById("about-company") as HTMLElement;
const header = () => card().firstElementChild as HTMLElement;

describe("About your company while it loads", () => {
  it("shows no save state until the facts arrive, then the real one", async () => {
    render(<CompanyFactsPanel />);
    expect(within(card()).queryByText("Not saved yet")).toBeNull();
    expect(header().querySelector(".animate-shimmer")).not.toBeNull();

    const updated = new Date(Date.now() - 16 * 60_000).toISOString();
    await act(async () => facts.resolve(json({ facts: [{ key: "company_name", value_text: "Pixel Drift", updated_at: updated }] })));

    expect(header().querySelector(".animate-shimmer")).toBeNull();
    expect(within(header()).getByText(/^Updated /)).toBeTruthy();
    expect(within(card()).queryByText("Not saved yet")).toBeNull();
  });

  it("says Not saved yet only once it knows nothing is saved", async () => {
    render(<CompanyFactsPanel />);
    expect(within(card()).queryByText("Not saved yet")).toBeNull();
    await act(async () => facts.resolve(json({ facts: [] })));
    expect(within(header()).getByText("Not saved yet")).toBeTruthy();
  });
});
