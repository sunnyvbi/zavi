
import { describe, expect, it } from "vitest";
import { addSiteRepoToUmbrellaConnector } from "@/services/sites/register-site-repo";
import { fakeConnectorClient } from "./connector-fake";

type Row = Record<string, unknown>;

const T = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const SITE1 = "Zavi-Latest-Build/austin-dog-grooming-d0ca391e-5e0b8e";
const SITE2 = "Zavi-Latest-Build/rise-shine-bakery-d0ca391e-f275dd";

function umbrella(tenant_id: string, repos: string[]): Row {
  return {
    tenant_id,
    slug: "github",
    account_login: "Praxis-build",
    repo_full_names: [...repos],
    default_repo_full_name: repos[0] ?? null,
    repo_default_branches: Object.fromEntries(repos.map((r) => [r, "main"])),
  };
}

describe("addSiteRepoToUmbrellaConnector", () => {
  it("adds the second site's repo and keeps the workspace default on site 1", async () => {
    const rows = [umbrella(T, [SITE1]), umbrella(OTHER, ["Zavi-Latest-Build/other"])];
    const { client } = fakeConnectorClient(rows);
    await expect(addSiteRepoToUmbrellaConnector(client, T, SITE2)).resolves.toBe("added");
    expect(rows[0].repo_full_names).toEqual([SITE1, SITE2]);
    expect(rows[0].default_repo_full_name).toBe(SITE1);
    expect(rows[0].repo_default_branches).toEqual({ [SITE1]: "main", [SITE2]: "main" });
    expect(rows[1].repo_full_names).toEqual(["Zavi-Latest-Build/other"]);
  });

  it("is idempotent: a repo already on the list is not written again", async () => {
    const rows = [umbrella(T, [SITE1, SITE2])];
    const { client, updates } = fakeConnectorClient(rows);
    await expect(addSiteRepoToUmbrellaConnector(client, T, SITE2)).resolves.toBe("present");
    expect(updates).toHaveLength(0);
  });

  it("never changes a GitHub account the user connected themselves", async () => {
    const rows: Row[] = [{ ...umbrella(T, ["acme/app"]), account_login: "acme" }];
    const { client, updates } = fakeConnectorClient(rows);
    await expect(addSiteRepoToUmbrellaConnector(client, T, SITE2)).resolves.toBe("not_umbrella");
    expect(updates).toHaveLength(0);
    expect(rows[0].repo_full_names).toEqual(["acme/app"]);
  });

  it("creates nothing when the tenant has no github row", async () => {
    const rows = [umbrella(OTHER, [SITE1])];
    const { client, updates } = fakeConnectorClient(rows);
    await expect(addSiteRepoToUmbrellaConnector(client, T, SITE2)).resolves.toBe("no_connector");
    expect(updates).toHaveLength(0);
  });

  it("never overwrites a racing build's append: the stale write loses the CAS and re-applies on top", async () => {
    const rows = [umbrella(T, [SITE1])];
    const SITE3 = "Zavi-Latest-Build/third-site-d0ca391e-aaaaaa";
    const { client, updates } = fakeConnectorClient(rows, {
      beforeUpdate: (n) => {
        if (n === 1) rows[0].repo_full_names = [SITE1, SITE3];
      },
    });
    await expect(addSiteRepoToUmbrellaConnector(client, T, SITE2)).resolves.toBe("added");
    expect(rows[0].repo_full_names).toEqual([SITE1, SITE3, SITE2]);
    expect(updates).toHaveLength(2);
  });

  it("gives up loudly after losing every attempt instead of reporting success", async () => {
    const rows = [umbrella(T, [SITE1])];
    let k = 0;
    const { client } = fakeConnectorClient(rows, {
      beforeUpdate: () => {
        rows[0].repo_full_names = [SITE1, `Zavi-Latest-Build/racer-${k++}`];
      },
    });
    await expect(addSiteRepoToUmbrellaConnector(client, T, SITE2)).rejects.toThrow(/lost 5 concurrent updates/);
  });

  it("a row with no list yet is matched by IS NULL", async () => {
    const rows = [{ ...umbrella(T, []), repo_full_names: null, default_repo_full_name: null }];
    const { client } = fakeConnectorClient(rows);
    await expect(addSiteRepoToUmbrellaConnector(client, T, SITE2)).resolves.toBe("added");
    expect(rows[0].repo_full_names).toEqual([SITE2]);
    expect(rows[0].default_repo_full_name).toBe(SITE2);
  });

  it("refuses an empty repo or tenant", async () => {
    const { client } = fakeConnectorClient([]);
    await expect(addSiteRepoToUmbrellaConnector(client, T, " ")).rejects.toThrow(/required/);
    await expect(addSiteRepoToUmbrellaConnector(client, "", SITE2)).rejects.toThrow(/required/);
  });
});
