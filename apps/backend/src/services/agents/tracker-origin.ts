
export type TrackerConnector = "jira" | "linear";

export type TrackerRef = {
  connector: TrackerConnector;
  key: string;
};

const KEY_RE = /\b([A-Z][A-Z0-9]{1,9}-\d{1,7})\b/g;

const JIRA_URL_RE =
  /https?:\/\/[a-z0-9.-]*atlassian\.net\/browse\/([A-Z][A-Z0-9]{1,9}-\d{1,7})/g;
const LINEAR_URL_RE =
  /https?:\/\/(?:linear\.app|lin\.run)\/[^\s)]*?\b([A-Z][A-Z0-9]{1,9}-\d{1,7})\b/g;

export function scanTrackerCandidates(text: string): {
  jiraUrlKeys: string[];
  linearUrlKeys: string[];
  bareKeys: string[];
} {
  const jiraUrlKeys = new Set<string>();
  const linearUrlKeys = new Set<string>();
  const bareKeys = new Set<string>();
  if (!text) return { jiraUrlKeys: [], linearUrlKeys: [], bareKeys: [] };

  for (const m of text.matchAll(JIRA_URL_RE)) jiraUrlKeys.add(m[1].toUpperCase());
  for (const m of text.matchAll(LINEAR_URL_RE))
    linearUrlKeys.add(m[1].toUpperCase());

  for (const m of text.matchAll(KEY_RE)) {
    const k = m[1].toUpperCase();
    if (!jiraUrlKeys.has(k) && !linearUrlKeys.has(k)) bareKeys.add(k);
  }

  return {
    jiraUrlKeys: [...jiraUrlKeys],
    linearUrlKeys: [...linearUrlKeys],
    bareKeys: [...bareKeys],
  };
}

export function resolveTrackerOrigin(
  text: string,
  enabled: { jira: boolean; linear: boolean },
): TrackerRef | null {
  const { jiraUrlKeys, linearUrlKeys, bareKeys } = scanTrackerCandidates(text);

  if (enabled.jira && jiraUrlKeys.length > 0) {
    return { connector: "jira", key: jiraUrlKeys[0] };
  }
  if (enabled.linear && linearUrlKeys.length > 0) {
    return { connector: "linear", key: linearUrlKeys[0] };
  }

  if (bareKeys.length > 0) {
    if (enabled.jira && !enabled.linear) {
      return { connector: "jira", key: bareKeys[0] };
    }
    if (enabled.linear && !enabled.jira) {
      return { connector: "linear", key: bareKeys[0] };
    }
  }

  return null;
}
