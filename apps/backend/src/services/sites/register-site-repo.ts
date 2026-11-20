
export const UMBRELLA_ACCOUNT_LOGIN = "Praxis-build";

type QueryResult<T> = { data: T | null; error: { message: string } | null };

export type RegisterSiteRepoClient = {
  from: (table: string) => unknown;
};

type ConnectorRow = {
  account_login?: string | null;
  repo_full_names?: string[] | null;
  default_repo_full_name?: string | null;
  repo_default_branches?: Record<string, string> | null;
};

export type RegisterSiteRepoOutcome =
  | "added"
  | "present"
  | "no_connector"
  | "not_umbrella";

const MAX_ATTEMPTS = 5;

/* eslint-disable @typescript-eslint/no-explicit-any */
async function readRow(sb: RegisterSiteRepoClient, tenant_id: string): Promise<ConnectorRow | null> {
  const { data, error } = (await (sb.from("connector_metadata") as any)
    .select("account_login, repo_full_names, default_repo_full_name, repo_default_branches")
    .eq("tenant_id", tenant_id)
    .eq("slug", "github")
    .maybeSingle()) as QueryResult<ConnectorRow>;
  if (error) throw new Error(`connector_metadata read failed: ${error.message}`);
  return data;
}

export async function addSiteRepoToUmbrellaConnector(
  sb: RegisterSiteRepoClient,
  tenant_id: string,
  repo_full_name: string,
  default_branch = "main",
): Promise<RegisterSiteRepoOutcome> {
  const repo = (repo_full_name ?? "").trim();
  if (!tenant_id || !repo) throw new Error("addSiteRepoToUmbrellaConnector: tenant_id and repo_full_name are required");
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const row = await readRow(sb, tenant_id);
    if (!row) return "no_connector";
    if (row.account_login !== UMBRELLA_ACCOUNT_LOGIN) return "not_umbrella";
    const raw = Array.isArray(row.repo_full_names) ? row.repo_full_names : null;
    const names = (raw ?? []).filter((n): n is string => typeof n === "string" && n.length > 0);
    if (names.includes(repo)) return "present";
    const branches = row.repo_default_branches && typeof row.repo_default_branches === "object" ? row.repo_default_branches : {};
    let q = (sb.from("connector_metadata") as any)
      .update({
        repo_full_names: [...names, repo],
        repo_default_branches: { ...branches, [repo]: branches[repo] ?? default_branch },
        ...(row.default_repo_full_name ? {} : { default_repo_full_name: repo }),
      })
      .eq("tenant_id", tenant_id)
      .eq("slug", "github")
      .eq("account_login", UMBRELLA_ACCOUNT_LOGIN);
    q = raw === null ? q.is("repo_full_names", null) : q.filter("repo_full_names", "eq", pgTextArrayLiteral(raw));
    const { data, error } = (await q.select("tenant_id")) as QueryResult<unknown[]>;
    if (error) throw new Error(`connector_metadata update failed: ${error.message}`);
    if (Array.isArray(data) && data.length > 0) return "added";
  }
  throw new Error(`addSiteRepoToUmbrellaConnector: ${repo} lost ${MAX_ATTEMPTS} concurrent updates in a row`);
}

export function pgTextArrayLiteral(values: readonly string[]): string {
  const quote = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return `{${values.map(quote).join(",")}}`;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
