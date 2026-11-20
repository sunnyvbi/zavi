import { getCompanyFacts, type CompanyFacts } from "@/services/company/facts";

export function cleanProductName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/[\r\n\t`*_<>{}[\]\\]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80).trim();
  return name.length >= 2 ? name : null;
}

export async function founderProductName(
  tenantId: string,
  readFacts: (tenantId: string) => Promise<Pick<CompanyFacts, "facts">> = getCompanyFacts,
): Promise<string | null> {
  try {
    const fact = (await readFacts(tenantId)).facts.company_name;
    if (!fact || fact.source !== "human_confirmed") return null;
    return cleanProductName(fact.value);
  } catch {
    return null;
  }
}
