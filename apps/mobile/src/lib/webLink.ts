const HOSTS = new Set(["www.zaviagent.com", "zaviagent.com"]);

const WORKSPACE_PAGES = new Set(["legacy", "members", "runs"]);

export function chatShareUrl(threadId: string, slug?: string): string {
  const agent = slug && slug !== "operator" ? `&agent=${encodeURIComponent(slug)}` : "";
  return `https://www.zaviagent.com/workspace/${encodeURIComponent(threadId)}?deeplink=thread${agent}`;
}

function ugcDrawerPath(q: URLSearchParams): string {
  const at = (path: string, params: Record<string, string | null>) => {
    const qs = Object.entries(params)
      .filter((e): e is [string, string] => !!e[1])
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&");
    return qs ? `${path}?${qs}` : path;
  };
  const one = (v: string | null) => (v ? encodeURIComponent(v) : "");
  const drawer = q.get("drawer");
  const job = q.get("job");
  const creator = q.get("creator");
  const brief = q.get("brief");
  if ((drawer === "job" || drawer === "review") && job) return `/channels/ugc/job/${one(job)}`;
  if (drawer === "thread" && creator) return `/channels/ugc/thread/${one(creator)}`;
  if (drawer === "applicants" && brief) return `/channels/ugc/applicants/${one(brief)}`;
  if (drawer === "brief") return `/channels/ugc/brief/${brief ? one(brief) : "new"}`;
  if (drawer === "inbox") return "/channels/ugc/inbox";
  if (drawer === "find") return "/channels/ugc/find";
  if (drawer === "hire") {
    const offer = q.get("offer");
    const pkg = q.get("package");
    const application = q.get("application");
    if (offer) return at("/channels/ugc/hire", { offer });
    if (pkg) return at("/channels/ugc/hire", { package: pkg });
    if (application && brief) return at("/channels/ugc/hire", { application, brief });
  }
  return "/channels/actions/ugc";
}

export const CONNECT_DONE_PATH = "/connectors/done";

function isConnectLanding(q: URLSearchParams): boolean {
  if (q.get("tab") !== "settings") return false;
  if (q.has("slack_error") || q.has("composio_error") || q.has("connect_error")) return true;
  let hit = false;
  q.forEach((v) => {
    if (v === "connected") hit = true;
  });
  return hit;
}

function donePath(q: URLSearchParams): string {
  const qs = q.toString();
  return qs ? `${CONNECT_DONE_PATH}?${qs}` : CONNECT_DONE_PATH;
}

export const CONNECT_FINISH_PATH = "/connectors/finish";

function finishPath(q: URLSearchParams): string {
  return `${CONNECT_FINISH_PATH}?${q.toString()}`;
}

export function connectReturnPath(url: URL): string | null {
  if (url.protocol === "zavi:" && url.hostname === "connectors" && url.pathname.replace(/\/$/, "") === "/done") {
    return donePath(url.searchParams);
  }
  if (url.protocol === "zavi:" && url.hostname === "connectors" && url.pathname.replace(/\/$/, "") === "/finish") {
    return finishPath(url.searchParams);
  }
  return null;
}

export function webLinkToAppPath(url: URL): string | null {
  if (url.protocol !== "https:" || !HOSTS.has(url.hostname)) return null;
  const parts = url.pathname.split("/").filter(Boolean);

  if (parts[0] === "connectors" && parts[1] === "finish" && url.hash.length > 1) {
    return finishPath(new URLSearchParams(url.hash.slice(1)));
  }

  if (parts[0] === "workspace") {
    if (!parts[1] && isConnectLanding(url.searchParams)) return donePath(url.searchParams);
    const id = parts[1];
    if (id && parts.length === 2 && !WORKSPACE_PAGES.has(id)) {
      const agent = url.searchParams.get("agent");
      const slug = agent ? `&slug=${encodeURIComponent(agent)}` : "";
      return `/chat?thread_id=${encodeURIComponent(id)}${slug}`;
    }
    if (!id && url.searchParams.get("tab") === "analytics") return "/analytics";
    if (!id && url.searchParams.get("tab") === "channels" && url.searchParams.get("channel") === "ugc") return ugcDrawerPath(url.searchParams);
    return "/chat";
  }
  if (parts[0] === "approvals") return "/chat";
  if (parts[0] === "growth") return "/growth";
  if (parts[0] === "connectors") return "/toolkit";
  if (parts[0] === "auth" && parts[1] === "reset") {
    const token = url.searchParams.get("token_hash");
    return token ? `/reset-password?token_hash=${encodeURIComponent(token)}` : "/reset-password";
  }
  if (parts[0] === "invite" && parts[1] === "accept") {
    const id = url.searchParams.get("id");
    return id ? `/invite/accept?id=${encodeURIComponent(id)}` : "/invite/accept";
  }
  return "/";
}
