
const ZAVI_HOSTS = ["onrender.com", "zaviagent.com"];

const UMBRELLA_LOGIN = "Praxis-build";

function hostOf(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.toLowerCase() || null;
  } catch {
    return null;
  }
}

export function isOwnSite(marketing: string | undefined | null): boolean {
  const host = hostOf(marketing);
  if (!host) return false;
  return !ZAVI_HOSTS.some((z) => host === z || host.endsWith(`.${z}`));
}

export function isZaviManagedGithubLogin(login: string | undefined | null): boolean {
  return (login ?? "").toLowerCase() === UMBRELLA_LOGIN.toLowerCase();
}

export function isZaviHostedRepoUrl(repoUrl: string | undefined | null): boolean {
  if (!repoUrl) return false;
  try {
    const url = new URL(repoUrl);
    if (url.host.toLowerCase() !== "github.com") return false;
    const owner = (url.pathname.split("/")[1] ?? "").toLowerCase();
    return owner === UMBRELLA_LOGIN.toLowerCase() || owner === "praxis-built";
  } catch {
    return false;
  }
}

export type ConnectorRow = { slug: string; account_login?: string | null };

export function hasOwnGithub(connectors: ConnectorRow[] | null): boolean | null {
  if (connectors === null) return null;
  return connectors.some(
    (c) => c.slug === "github" && (c.account_login ?? "") !== UMBRELLA_LOGIN,
  );
}
