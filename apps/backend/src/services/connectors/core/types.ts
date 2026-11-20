
export type ConnectorExchangeResult = {
  secrets: Record<string, string>;
  expiresInSec?: number;
  metadata: {
    team_id: string;
    team_name: string;
    scopes: string[];
  };
};

export type ConnectorIdentity = {
  team_id: string;
  team_name: string;
};

export type ConnectorRefreshResult = {
  secrets: Record<string, string>;
  expiresInSec: number;
};

export interface ConnectorOAuth {
  slug: string;
  serverId: string;
  scopes: string[];
  codeParam?: "code" | "auth_code";
  authorizeUrl(state: string, redirectUri: string): string;
  exchangeCode(
    code: string,
    redirectUri: string,
    rawState?: string,
  ): Promise<ConnectorExchangeResult>;
  refreshToken?(tenant_id: string): Promise<ConnectorRefreshResult>;
  fetchIdentity?(tenant_id: string): Promise<ConnectorIdentity | null>;
  revokeToken?: (accessToken: string) => Promise<void>;
  bindCallbackToSession?: boolean;
  onConnect?: (tenant_id: string) => Promise<void>;
  onDisconnect?: (tenant_id: string) => Promise<void>;
}
