
type Severity = "blocker" | "high" | "medium" | string;

export type HypothesisSeoInput = {
  status: "ok" | "error";
  error_code: string | null;
  pages_analyzed: number;
  web_pages?: number;
  non_html_urls?: string[];
  findings: Array<{
    code: string;
    severity: Severity;
    summary: string;
    urls: string[];
    scope?: "site" | "partial";
  }>;
} | null;

export type HypothesisResearchInput = {
  status: "pending" | "ready" | "thin" | "failed";
  source_count: number;
  source_hosts: string[];
  competitors: Array<{ name: string; url: string }>;
};

export type HypothesisInput = {
  oneLiner: string | null;
  stage: number | null;
  gtmMotion: string | null;
  hasSite: boolean;
  seo: HypothesisSeoInput;
  research?: HypothesisResearchInput | null;
};

export type GrowthHypothesis = {
  statement: string;
  confidence: "low" | "medium";
  evidence: string[];
  cannot_see: string[];
  question: string;
  blocking?: boolean;
};

const BLIND = [
  "how many people visit or where they come from",
  "what happens after someone signs up",
];

function countBy(findings: HypothesisSeoInput extends null ? never : NonNullable<HypothesisSeoInput>["findings"], sev: string): number {
  return findings.filter((f) => f.severity === sev).length;
}

function webPagesOf(seo: NonNullable<HypothesisSeoInput>): number {
  return seo.web_pages ?? seo.pages_analyzed;
}

function whatWasRead(seo: NonNullable<HypothesisSeoInput>): string {
  const web = webPagesOf(seo);
  if (web === seo.pages_analyzed) return `${web} page(s)`;
  return web === 0 ? `${seo.pages_analyzed} file(s) (no web pages)` : `${seo.pages_analyzed} file(s) (${web} web page(s))`;
}

function siteWideBlocker(seo: NonNullable<HypothesisSeoInput>): GrowthHypothesis | null {
  if (seo.status === "error" || seo.error_code === "seo_site_unreachable") {
    return {
      statement:
        "I couldn't load your site when I went looking. If it's down or blocking readers, that's upstream of every other growth problem.",
      confidence: "low",
      blocking: true,
      evidence: ["Tried to read your site and got no usable page back"],
      cannot_see: BLIND,
      question: "Is your site live and reachable right now?",
    };
  }

  const indexing = seo.findings.find(
    (f) => f.code === "robots_disallow_all" || f.code === "noindex",
  );
  if (indexing && (indexing.code === "robots_disallow_all" || (indexing.scope === "site" && webPagesOf(seo) > 0))) {
    return {
      statement:
        "Your site is currently telling search engines not to list it, so people can't find you that way even if they're looking.",
      confidence: "medium",
      evidence: [indexing.summary, `Read ${whatWasRead(seo)} on your site`],
      cannot_see: BLIND,
      question: "Is that deliberate, or should people be able to find you on Google?",
      blocking: true,
    };
  }
  return null;
}

export function buildHypothesis(input: HypothesisInput): GrowthHypothesis | null {
  const { seo, stage, hasSite } = input;

  if (hasSite && seo !== null && seo.error_code !== "seo_site_unknown") {
    const blocker = siteWideBlocker(seo);
    if (blocker) return blocker;
  }

  const research = input.research ?? null;
  if (research && research.status === "ready" && research.source_count >= 2) {
    const named = research.competitors
      .map((c) => c.name.trim())
      .filter((n) => n.length > 0)
      .slice(0, 3);
    if (named.length >= 2) {
      const list =
        named.length === 2
          ? `${named[0]} and ${named[1]}`
          : `${named[0]}, ${named[1]} and ${named[2]}`;
      return {
        statement: `Before asking you anything I went and read what the web says about you, and you keep coming up next to ${list}. When a category already has names people recognise, the fight is usually over why you rather than whether anyone shows up at all.`,
        confidence: "medium",
        evidence: [
          `Read ${research.source_count} page(s) about you from outside your own site`,
          `Saw you named alongside ${list}`,
        ],
        cannot_see: BLIND,
        question: "When someone picks you over one of those, what reason do they give?",
      };
    }
    const hosts = research.source_hosts.filter((h) => h.length > 0).slice(0, 3);
    if (hosts.length > 0) {
      return {
        statement: `Before asking you anything I read what's written about you off your own site — ${hosts.join(", ")} and the like. That's the version of you a buyer meets before they ever reach your own pages, and it's what I'm going to be reasoning from.`,
        confidence: "medium",
        evidence: [
          `Read ${research.source_count} page(s) about you from outside your own site`,
          `Sources included ${hosts.join(", ")}`,
        ],
        cannot_see: BLIND,
        question: "Does that match how you'd describe yourselves, or is it out of date?",
      };
    }
  }

  if (!hasSite || seo === null || seo.error_code === "seo_site_unknown") return null;

  const high = countBy(seo.findings, "high");

  const indexing = seo.findings.find(
    (f) => f.code === "robots_disallow_all" || f.code === "noindex",
  );
  if (indexing && indexing.urls.length > 0) {
    const [firstUrl] = indexing.urls;
    const many = indexing.urls.length > 1;
    const nonHtml = new Set(seo.non_html_urls ?? []);
    const filesOnly = webPagesOf(seo) === 0 || indexing.urls.every((u) => nonHtml.has(u));
    const noun = filesOnly ? "file" : "page";
    const read = webPagesOf(seo) === 0 ? `${seo.pages_analyzed} file(s)` : whatWasRead(seo);
    const rest =
      indexing.urls.length < seo.pages_analyzed
        ? ` The rest of what I read looks listable, so this is ${noun}-level rather than your whole site.`
        : "";
    return {
      statement: many
        ? `${indexing.urls.length} of the ${read} I read are telling search engines not to list them, starting with ${firstUrl}.${rest}`
        : `One of the ${read} I read is telling search engines not to list it: ${firstUrl}.${rest}`,
      confidence: "medium",
      evidence: [indexing.summary, `Read ${whatWasRead(seo)} on your site`],
      cannot_see: BLIND,
      question: many
        ? `Is that deliberate for those ${noun}s, or should they be findable on Google?`
        : `Is that deliberate for that ${noun}, or should it be findable on Google?`,
    };
  }

  if (typeof stage === "number" && stage <= 1) {
    return {
      statement:
        "You're early, so my starting assumption is that the constraint is simply that almost nobody knows you exist yet.",
      confidence: "low",
      evidence: ["Your company file has you at pre-launch or just-launched"],
      cannot_see: BLIND,
      question: "Does that match where you are, or is something else in the way?",
    };
  }

  if (high >= 3) {
    return {
      statement:
        "Your site has a handful of things working against it being found and understood, which usually shows up as too few people arriving.",
      confidence: "low",
      evidence: [
        ...seo.findings.filter((f) => f.severity === "high").slice(0, 2).map((f) => f.summary),
        `Read ${whatWasRead(seo)} on your site`,
      ],
      cannot_see: BLIND,
      question: "Is getting found the thing you'd most want fixed, or is it something later?",
    };
  }

  if (webPagesOf(seo) > 0) {
    return {
      statement:
        "Your site reads clean to me technically, so I don't think being found is your main problem. That usually means it's what happens after people land.",
      confidence: "low",
      evidence: [
        `Read ${webPagesOf(seo)} page(s) and found nothing blocking discovery`,
      ],
      cannot_see: BLIND,
      question: "Where do you actually lose people?",
    };
  }

  return null;
}
