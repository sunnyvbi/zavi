
export const GITHUB_CONNECTOR_HREF = "/workspace?tab=brain#connector-github";

export type ExportErrorCopy =
  | { kind: "connect" }
  | {
      kind: "create_repo";
      repoName: string | null;
      owner: string | null;
      reason: "personal_account" | "no_create_permission";
    }
  | { kind: "raw"; message: string };

const FRIENDLY: Record<string, string> = {
  no_provisioned_repo: "This build has no code to export yet. It arrives once the build finishes.",
  build_not_found: "That build isn't in this workspace any more. Open the build you want to export and try again.",
  build_session_not_found: "That build isn't in this workspace any more. Open the build you want to export and try again.",
  invalid_build_session: "That build link isn't valid. Open the build you want to export and try again.",
  build_session_check_failed: "We couldn't check this build just now. Try again in a moment.",
  not_zavi_managed: "This build's code is already in your own GitHub repo, so there is nothing to export.",
  dest_repo_changed_since_export:
    "Someone pushed to that repo after the last export, so Zavi won't overwrite it. Export to a new repo name, or copy your changes somewhere safe first.",
  export_not_configured: "Export isn't available right now. Try again later.",
  forbidden: "Only workspace owners and admins can export the code.",
  network: "We couldn't reach Zavi. Check your connection and try again.",
};

export function exportErrorCopy(
  code: string,
  message: string,
  fallbackRepoName: string | null = null,
): ExportErrorCopy {
  if (code === "github_not_connected") return { kind: "connect" };

  if (code === "dest_repo_must_exist") {
    const named = message.match(/named "([^"]+)" under ([^\s]+) on GitHub/);
    return {
      kind: "create_repo",
      repoName: named?.[1] ?? fallbackRepoName,
      owner: named?.[2] ?? null,
      reason: "personal_account",
    };
  }

  if (code === "export_failed") {
    if (/export dest repo create failed \((403|404)\)/.test(message)) {
      return {
        kind: "create_repo",
        repoName: fallbackRepoName,
        owner: null,
        reason: "no_create_permission",
      };
    }
  }

  const plain = FRIENDLY[code];
  if (plain) return { kind: "raw", message: plain };

  return { kind: "raw", message };
}

export function repoNameFromUrl(repoUrl: string | null | undefined): string | null {
  if (!repoUrl) return null;
  const last = repoUrl.replace(/\/+$/, "").split("/").pop() ?? "";
  const name = last.replace(/\.git$/, "");
  return name || null;
}

export function githubNewRepoUrl(owner: string, repoName: string): string {
  const q = new URLSearchParams({ name: repoName, owner, visibility: "private" });
  return `https://github.com/new?${q.toString()}`;
}
