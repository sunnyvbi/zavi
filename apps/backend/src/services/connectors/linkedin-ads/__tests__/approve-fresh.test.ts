import { beforeEach, expect, it, vi } from "vitest";

vi.mock("@/services/connectors/core/token", () => ({ getConnectorToken: async () => "tok", forceRefreshConnector: vi.fn() }));

import { listLinkedInAdAccountsWithReference } from "../client";
import { countLinkedInAdsCalls } from "../http";

const fetchMock = vi.fn();
const page = (elements: unknown[]) => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ elements }) });
const acme = { id: 11, name: "Acme Ads", currency: "USD", status: "ACTIVE", reference: "urn:li:organization:42" };

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

it("sees an account LinkedIn removed after the review cached it, when approve reads fresh", async () => {
  fetchMock.mockResolvedValueOnce(page([acme])).mockResolvedValue(page([]));
  expect((await listLinkedInAdAccountsWithReference("tenant")).map((a) => a.id)).toEqual(["11"]);
  expect((await listLinkedInAdAccountsWithReference("tenant")).map((a) => a.id)).toEqual(["11"]);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await expect(listLinkedInAdAccountsWithReference("tenant", true)).resolves.toEqual([]);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await expect(listLinkedInAdAccountsWithReference("tenant")).resolves.toEqual([]);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("costs one LinkedIn call for a review, none for a reopen and one for approve", async () => {
  fetchMock.mockResolvedValue(page([acme]));
  const review = countLinkedInAdsCalls(() => listLinkedInAdAccountsWithReference("tenant"));
  await review.result;
  const reopen = countLinkedInAdsCalls(() => listLinkedInAdAccountsWithReference("tenant"));
  await reopen.result;
  const approve = countLinkedInAdsCalls(() => listLinkedInAdAccountsWithReference("tenant", true));
  await approve.result;
  expect([review.calls, reopen.calls, approve.calls]).toEqual([["GET adAccounts"], [], ["GET adAccounts"]]);
});
