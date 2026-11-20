
import {
  isAuthLaunchRequest,
  type AuthLaunchResponse,
} from "../shared/messages";
import { panelPathFor } from "../shared/panel-path";
import { forgetTab } from "../shared/tab-state";

chrome.action.onClicked.addListener((tab) => {
  const tabId = tab?.id;
  if (typeof tabId !== "number") return;

  void chrome.sidePanel
    .setOptions({ tabId, path: panelPathFor(tabId), enabled: true })
    .catch((e: unknown) => console.error("[zavi] setOptions failed", e));

  void chrome.sidePanel.open({ tabId }).catch((e: unknown) => {
    console.error("[zavi] sidePanel.open failed", e);
  });
});

chrome.tabs.onRemoved.addListener((tabId: number) => {
  void forgetTab(tabId);
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: false })
    .catch((e: unknown) => {
      console.error("[zavi] setPanelBehavior failed", e);
    });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isAuthLaunchRequest(message)) return false;

  chrome.identity
    .launchWebAuthFlow({ url: message.url, interactive: true })
    .then((redirectUrl) => {
      const res: AuthLaunchResponse = redirectUrl
        ? { ok: true, redirectUrl }
        : { ok: false, error: "Sign-in was closed before it finished." };
      sendResponse(res);
    })
    .catch((e: unknown) => {
      const res: AuthLaunchResponse = {
        ok: false,
        error: e instanceof Error ? e.message : "Sign-in failed.",
      };
      sendResponse(res);
    });

  return true;
});
