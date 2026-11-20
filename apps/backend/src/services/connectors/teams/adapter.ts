
/* eslint-disable @typescript-eslint/no-explicit-any */

const BOTBUILDER_MODULE = "botbuilder";
async function loadBotbuilder(): Promise<any> {
  return import(BOTBUILDER_MODULE);
}

export type TeamsEnv = {
  appId: string;
  appPassword: string;
  appType: string;
  appTenantId: string;
};

export function teamsEnabled(): boolean {
  return Boolean(process.env.MICROSOFT_APP_ID && process.env.MICROSOFT_APP_PASSWORD);
}

export function teamsEnv(): TeamsEnv | null {
  if (!teamsEnabled()) return null;
  return {
    appId: String(process.env.MICROSOFT_APP_ID),
    appPassword: String(process.env.MICROSOFT_APP_PASSWORD),
    appType: String(process.env.MICROSOFT_APP_TYPE ?? "SingleTenant"),
    appTenantId: String(process.env.MICROSOFT_APP_TENANT_ID ?? ""),
  };
}

let _adapter: any | null = null;

export async function getTeamsAdapter(): Promise<any | null> {
  const env = teamsEnv();
  if (!env) return null;
  if (_adapter) return _adapter;

  const bb: any = await loadBotbuilder();
  const auth = new bb.ConfigurationBotFrameworkAuthentication({
    MicrosoftAppId: env.appId,
    MicrosoftAppPassword: env.appPassword,
    MicrosoftAppType: env.appType,
    MicrosoftAppTenantId: env.appTenantId,
  });
  _adapter = new bb.CloudAdapter(auth);
  return _adapter;
}

export async function getConversationReference(activity: any): Promise<any> {
  const bb: any = await loadBotbuilder();
  return bb.TurnContext.getConversationReference(activity);
}
