"use client";

import { useEffect } from "react";

export function MagicLinkFragmentCatcher(): null {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const { pathname, hash, search } = window.location;
    if (pathname.startsWith("/auth/callback")) return;

    const hashParams = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
    const queryParams = new URLSearchParams(search);
    const hasAuthPayload = Boolean(
      (hashParams.get("access_token") && hashParams.get("refresh_token")) ||
        (hashParams.get("token_hash") && hashParams.get("type")) ||
        (queryParams.get("token_hash") && queryParams.get("type")),
    );
    if (!hasAuthPayload) return;

    window.location.replace(`/auth/callback${search}${hash}`);
  }, []);

  return null;
}
