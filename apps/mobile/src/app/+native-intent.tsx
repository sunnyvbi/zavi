import { completeBrowserOAuth } from "../auth/oauth";
import { connectReturnPath, webLinkToAppPath } from "../lib/webLink";

export async function redirectSystemPath({
  path,
}: {
  path: string;
  initial: boolean;
}): Promise<string> {
  try {
    const url = new URL(path);
    if (
      (url.hostname === "auth" && url.pathname === "/callback") ||
      url.pathname === "/auth/callback"
    ) {
      void completeBrowserOAuth(path).catch(() => {});
      if (url.hash) return "/auth/callback";
      return `/auth/callback?callbackUrl=${encodeURIComponent(path)}`;
    }
    const done = connectReturnPath(url);
    if (done) return done;
    const appPath = webLinkToAppPath(url);
    if (appPath) return appPath;
  } catch {
    return path;
  }
  return path;
}
