const PRODUCTION_API = "https://api.zaviagent.com";

let warned = false;

export function resetApiBaseWarningForTests(): void {
  warned = false;
}

export function publicApiBaseUrl(env: Record<string, string | undefined> = process.env): string {
  const configured = (env.PUBLIC_API_URL?.trim() || env.BACKEND_PUBLIC_URL?.trim() || "").replace(/\/+$/, "");
  if (configured) return configured;
  if (env.NODE_ENV === "production") return PRODUCTION_API;
  const port = env.PORT?.trim() || "3001";
  const local = `http://localhost:${port}`;
  if (!warned) {
    warned = true;
    console.warn(
      `[api-base] PUBLIC_API_URL and BACKEND_PUBLIC_URL are unset outside production; email links will point at ${local}`,
    );
  }
  return local;
}
