
import { describe, expect, it } from "vitest";

import { deriveApp, statusToBuildStatus, type TenantResource } from "./useBuildProduct";

type Case = {
  name: string;
  resources: TenantResource[] | null | undefined;
  expected: { status: string; url: string | null };
};

const cases: Case[] = [
  {
    name: "no resources at all → none",
    resources: undefined,
    expected: { status: "none", url: null },
  },
  {
    name: "no hosting resource → none",
    resources: [{ resource_kind: "repo", status: "ready" }],
    expected: { status: "none", url: null },
  },
  {
    name: "hosting pending → building, no url",
    resources: [{ resource_kind: "hosting", status: "pending" }],
    expected: { status: "building", url: null },
  },
  {
    name: "hosting provisioning → building",
    resources: [{ resource_kind: "hosting", status: "provisioning" }],
    expected: { status: "building", url: null },
  },
  {
    name: "hosting ready WITH url → live",
    resources: [
      {
        resource_kind: "hosting",
        status: "ready",
        external_ref: { url: "https://acme-app.onrender.com", render_service_id: "srv-1" },
      },
    ],
    expected: { status: "live", url: "https://acme-app.onrender.com" },
  },
  {
    name: "hosting ready but url not yet populated → building, NOT live (P0-2: never a 'live' card stuck on Resolving…)",
    resources: [{ resource_kind: "hosting", status: "ready", external_ref: {} }],
    expected: { status: "building", url: null },
  },
  {
    name: "hosting provisioning WITH a url present → still building, url withheld (A4: no clickable URL mid-deploy)",
    resources: [
      {
        resource_kind: "hosting",
        status: "provisioning",
        external_ref: { url: "https://acme-app.onrender.com" },
      },
    ],
    expected: { status: "building", url: null },
  },
  {
    name: "hosting failed → failed",
    resources: [{ resource_kind: "hosting", status: "failed" }],
    expected: { status: "failed", url: null },
  },
  {
    name: "hosting torn_down → none",
    resources: [{ resource_kind: "hosting", status: "torn_down" }],
    expected: { status: "none", url: null },
  },
];

describe("useBuildProduct.deriveApp", () => {
  for (const c of cases) {
    it(c.name, () => {
      expect(deriveApp(c.resources)).toEqual(c.expected);
    });
  }
});

describe("useBuildProduct.statusToBuildStatus", () => {
  it("unknown forward-compat status defaults to building", () => {
    expect(statusToBuildStatus("some_future_state", null)).toEqual("building");
  });
});
