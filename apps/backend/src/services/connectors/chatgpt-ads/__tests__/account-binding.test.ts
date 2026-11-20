import { beforeEach, expect, it, vi } from "vitest";
import type { AccountBinding } from "@/services/ads-wallet/bindings";
const m = vi.hoisted(() => ({ key:vi.fn(),get:vi.fn(),verify:vi.fn() }));
vi.mock("../key-provider", () => ({ getChatgptAdsApiKey:m.key }));
vi.mock("../http", () => ({ chatgptAdsGet:m.get }));
vi.mock("@/services/ads-wallet/bindings", () => ({ verifyAccountBinding:m.verify }));
import { resolveChatgptAccount } from "../account-binding";
const binding: AccountBinding = { id:"binding",tenant_id:"t",account_id:"account",platform:"chatgpt",provider_account_id:null,currency:null,verified_at:null,credential_source:"platform",credential_ref:"chatgpt_ads_api_key",credential_tenant_id:null,funding_source:"wallet",legacy_key:"chatgpt_platform" };
beforeEach(() => { vi.resetAllMocks(); m.key.mockResolvedValue("secret"); m.get.mockResolvedValue({id:"account-verified",currency_code:"USD"}); });
it("verifies the account returned by the bound credential before returning a usable key", async () => {
  expect(await resolveChatgptAccount("t",binding)).toEqual({key:"secret",account:{id:"account-verified",currency_code:"USD"}});
  expect(m.get).toHaveBeenCalledWith("secret","/ad_account");
  expect(m.verify).toHaveBeenCalledWith("t",binding,"account-verified","USD");
});
it.each([
  {tenant_id:"other"}, {platform:"linkedin"}, {credential_source:"tenant_connector"},
  {credential_ref:"different_secret"}, {credential_tenant_id:"other"}, {funding_source:"provider"},
])("rejects unsupported or foreign binding %o without reading a credential", async change => {
  await expect(resolveChatgptAccount("t",{...binding,...change} as AccountBinding)).rejects.toMatchObject({code:"ads_account_unsupported"});
  expect(m.key).not.toHaveBeenCalled(); expect(m.get).not.toHaveBeenCalled();
});
it.each([{}, {id:"",currency_code:"USD"}, {id:123,currency_code:"USD"}, {id:"a"}])("refuses an unverified account response %o", async response => {
  m.get.mockResolvedValue(response);
  await expect(resolveChatgptAccount("t",binding)).rejects.toMatchObject({code:"ads_binding_unavailable"});
  expect(m.verify).not.toHaveBeenCalled();
});
it("never returns the key when atomic verification rejects credential drift", async () => {
  m.verify.mockRejectedValue(new Error("identity changed"));
  await expect(resolveChatgptAccount("t",binding)).rejects.toThrow("identity changed");
});
