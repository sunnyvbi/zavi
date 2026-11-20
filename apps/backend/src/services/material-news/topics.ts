
import { tenantClient, asTenantId } from "@/services/tenant-client";
import { getAnthropic, heliconePropertyHeaders } from "@/services/anthropic";
import { MODELS } from "@/services/llm/models";
import { scrubSecretsFromText } from "@/services/mcp/egress-secret-scrub";

export const MAX_TOPICS = 8;
export const MIN_ANCHORS_FOR_TOPICS = 2;
const MAX_ANCHOR_BODY_CHARS = 2_000;
const MAX_ANCHORS_INTO_PROMPT = 20;

export type AnchorLite = {
  id: string;
  title: string;
  body: string;
  created_at: string;
  updated_at: string;
};

export type TopicsCache = { terms: string[]; fp?: string };

function anchorFingerprint(anchors: AnchorLite[]): string {
  const newest = anchors.reduce((m, a) => (a.updated_at > m ? a.updated_at : m), "");
  return `${anchors.length}:${newest}`;
}

export async function loadAnchors(tenant_id: string): Promise<AnchorLite[]> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("memory_note")
    .select("id, title, body_markdown, created_at, updated_at")
    .eq("note_type", "anchor")
    .neq("source", "agent_discovery_inferred")
    .is("superseded_by", null)
    .is("archived_at", null);
  if (error) {
    throw new Error(`material-news topics: anchor read failed: ${error.message}`);
  }
  return (data ?? []).map((r) => {
    const created = String((r as { created_at: string }).created_at);
    return {
      id: String((r as { id: string }).id),
      title: String((r as { title: string | null }).title ?? ""),
      body: String((r as { body_markdown: string | null }).body_markdown ?? ""),
      created_at: created,
      updated_at: String((r as { updated_at: string | null }).updated_at ?? created),
    };
  });
}

export function isPublicSafeTerm(raw: string): boolean {
  const term = raw.trim();
  if (term.length < 2 || term.length > 60) return false;
  if (scrubSecretsFromText(term).redactions.length > 0) return false;
  if (/[@]/.test(term)) return false;
  if (/https?:\/\//i.test(term)) return false;
  if (/\+?\d[\d\s().-]{6,}\d/.test(term)) return false;
  if (/[$%]/.test(term)) return false;
  if (/\d{3,}/.test(term)) return false;
  for (const tok of term.split(/\s+/)) {
    if (/^\d+$/.test(tok)) return false;
    if (/\d/.test(tok) && /^[0-9a-f]{6,}$/i.test(tok)) return false;
  }
  if (!/[a-zA-Z]/.test(term)) return false;
  return true;
}

const TOPICS_SYSTEM = `You extract PUBLIC-SAFE web-search topics for a company from its private business notes.
Return ONLY topics that are safe to type into a public search engine: the company's INDUSTRY, its market CATEGORY, named PUBLIC competitors, and relevant REGULATORS or public bodies.
NEVER return: customer names, employee names, internal metrics, revenue/counts/dollar-figures, secrets, credentials, product code-names, or anything that would reveal private business information.
Output strict JSON: {"terms": string[]} with 3 to ${MAX_TOPICS} short public terms (2-5 words each, no digits). If the notes have no public-safe signal, return {"terms": []}.`;

export async function deriveTopics(
  tenant_id: string,
  anchors: AnchorLite[],
): Promise<string[] | null> {
  const notesBlock = anchors
    .slice(0, MAX_ANCHORS_INTO_PROMPT)
    .map(
      (a, i) =>
        `NOTE ${i + 1} — ${a.title}\n${a.body.slice(0, MAX_ANCHOR_BODY_CHARS)}`,
    )
    .join("\n\n");

  const anthropic = getAnthropic();
  const resp = await anthropic.messages.create(
    {
      model: MODELS.anthropic.haiku,
      max_tokens: 300,
      system: TOPICS_SYSTEM,
      messages: [
        {
          role: "user",
          content: `Company brain notes (PRIVATE — do not echo their contents, only distill public topics):\n\n${notesBlock}\n\nReturn the JSON now.`,
        },
      ],
    },
    { headers: heliconePropertyHeaders({ tenantId: tenant_id, agentSlug: "material-news" }) },
  );

  const text =
    resp.content[0]?.type === "text" ? resp.content[0].text : "";
  let parsed: unknown;
  try {
    const json = text.trim().replace(/^```(?:json)?/i, "").replace(/```\s*$/i, "").trim();
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const terms = (parsed as { terms?: unknown })?.terms;
  if (!Array.isArray(terms)) return null;
  return terms.filter((t): t is string => typeof t === "string");
}

const VERIFY_SYSTEM = `You are a privacy backstop for web-search terms about a company.
Return ONLY the candidate terms that are UNAMBIGUOUSLY PUBLIC: an industry, a market category, a widely-known public competitor brand, or a public regulator/body.
DROP anything that could be PRIVATE to a single company: a customer name, an employee name, an internal product or project code-name, or any term you do not recognize as a public entity. When in doubt, DROP it.
Never invent new terms — only return terms from the given list.
Output strict JSON: {"public": string[]}.`;

export async function verifyPublicTerms(
  tenant_id: string,
  terms: string[],
): Promise<string[] | null> {
  if (terms.length === 0) return [];
  const anthropic = getAnthropic();
  let resp;
  try {
    resp = await anthropic.messages.create(
      {
        model: MODELS.anthropic.haiku,
        max_tokens: 300,
        system: VERIFY_SYSTEM,
        messages: [
          {
            role: "user",
            content: `Candidate terms:\n${terms.map((t) => `- ${t}`).join("\n")}\n\nReturn the JSON now.`,
          },
        ],
      },
      { headers: heliconePropertyHeaders({ tenantId: tenant_id, agentSlug: "material-news" }) },
    );
  } catch {
    return null;
  }
  const text = resp.content[0]?.type === "text" ? resp.content[0].text : "";
  try {
    const json = text.trim().replace(/^```(?:json)?/i, "").replace(/```\s*$/i, "").trim();
    const pub = (JSON.parse(json) as { public?: unknown }).public;
    if (!Array.isArray(pub)) return null;
    const allowed = new Set(terms.map((t) => t.toLowerCase()));
    return pub.filter((t): t is string => typeof t === "string" && allowed.has(t.toLowerCase()));
  } catch {
    return null;
  }
}

export async function getOrRefreshTopics(
  tenant_id: string,
  anchors: AnchorLite[],
): Promise<string[] | null> {
  const tc = tenantClient(asTenantId(tenant_id));
  if (anchors.length < MIN_ANCHORS_FOR_TOPICS) return null;

  const fp = anchorFingerprint(anchors);

  const { data: cacheRow } = await tc
    .from("news_topics")
    .select("topics, refreshed_at")
    .maybeSingle<{ topics: TopicsCache; refreshed_at: string }>();

  if (cacheRow && cacheRow.topics?.fp === fp) {
    const cached = Array.isArray(cacheRow.topics?.terms) ? cacheRow.topics.terms : [];
    return cached.length > 0 ? cached : null;
  }

  const candidate = await deriveTopics(tenant_id, anchors);
  if (candidate === null) return null;

  const shaped = Array.from(
    new Set(candidate.filter(isPublicSafeTerm).map((t) => t.trim())),
  );
  const verified = shaped.length > 0 ? await verifyPublicTerms(tenant_id, shaped) : [];
  if (verified === null) return null;

  const safe = verified.slice(0, MAX_TOPICS);

  await tc.from("news_topics").upsert(
    {
      topics: { terms: safe, fp } satisfies TopicsCache,
      refreshed_at: new Date().toISOString(),
    },
    { onConflict: "tenant_id" },
  );

  return safe.length > 0 ? safe : null;
}
