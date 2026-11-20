
export type PipedreamEnvironment = "development" | "production";

export type PipedreamCreds = {
  clientId: string;
  clientSecret: string;
  projectId: string;
  environment: PipedreamEnvironment;
};

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    throw new Error(
      `${name} missing. Set it in AWS Secrets Manager praxis-envprod-1 ` +
        "(per apps/backend/CLAUDE.md) and restart the container.",
    );
  }
  return v;
}

export function getPipedreamCreds(): PipedreamCreds {
  const envRaw = (process.env.PIPEDREAM_ENVIRONMENT?.trim() || "production").toLowerCase();
  const environment: PipedreamEnvironment =
    envRaw === "development" ? "development" : "production";
  return {
    clientId: requireEnv("PIPEDREAM_CLIENT_ID"),
    clientSecret: requireEnv("PIPEDREAM_CLIENT_SECRET"),
    projectId: requireEnv("PIPEDREAM_PROJECT_ID"),
    environment,
  };
}

export const PIPEDREAM_MCP_BASE_URL = "https://remote.mcp.pipedream.net/v3";

export const PIPEDREAM_API_BASE_URL = "https://api.pipedream.com/v1";
