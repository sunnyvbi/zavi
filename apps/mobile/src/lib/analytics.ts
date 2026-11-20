import { Platform } from "react-native";
import { Mixpanel } from "mixpanel-react-native";
import PostHog from "posthog-react-native";
import { appEnvironment, failureReason, screenFromSegments, sendsToMixpanel } from "./analyticsCore";

type EventProps = Record<string, string | number | boolean | null | undefined>;
type CleanProps = Record<string, string | number | boolean | null>;

const key = process.env.EXPO_PUBLIC_POSTHOG_KEY;
const mixpanelToken = process.env.EXPO_PUBLIC_MIXPANEL_TOKEN;
const environment = appEnvironment(__DEV__, process.env.EXPO_PUBLIC_APP_ENV);
const analyticsOn =
  !!key &&
  key !== "undefined" &&
  Platform.OS !== "web" &&
  (!__DEV__ || process.env.EXPO_PUBLIC_POSTHOG_IN_DEV === "true");
const mixpanelOn = !!mixpanelToken && mixpanelToken !== "undefined" && Platform.OS !== "web";

const posthog = analyticsOn
  ? new PostHog(key, {
      host: "https://us.i.posthog.com",
      personProfiles: "identified_only",
      captureAppLifecycleEvents: true,
      capturePushNotificationSubscriptions: false,
      capturePushNotificationOpened: false,
      before_send: (event) => {
        if (!event) return event;
        const { url: _url, ...properties } = event.properties ?? {};
        return { ...event, properties: { ...properties, $lib: Platform.OS } };
      },
      enableSessionReplay: true,
      sessionReplayConfig: {
        maskAllTextInputs: true,
        maskAllImages: true,
        maskAllSandboxedViews: true,
        captureLog: false,
        captureNetworkTelemetry: false,
      },
    })
  : null;

const mixpanelProps = { platform: Platform.OS, environment, client: "mobile_app" };

const mixpanel = mixpanelOn ? new Mixpanel(mixpanelToken, false, false) : null;

const mixpanelReady = mixpanel
  ?.init()
  .then(() => {
    mixpanel?.setUseIpAddressForGeolocation(false);
    return true;
  })
  .catch(() => false);

function onMixpanel(run: (mp: Mixpanel) => void): void {
  void mixpanelReady
    ?.then((ready) => {
      if (ready && mixpanel) run(mixpanel);
    })
    .catch(() => {});
}

let identifiedId: string | null = null;

function cleanProps(props?: EventProps): CleanProps {
  const clean: CleanProps = {};
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v !== undefined) clean[k] = v;
  }
  return clean;
}

try {
  posthog?.register({
    platform: Platform.OS,
    environment,
  });
} catch {}

export function track(event: string, props?: EventProps): void {
  const clean = cleanProps(props);
  try {
    posthog?.capture(event, clean);
  } catch {}
  if (sendsToMixpanel(event)) onMixpanel((mp) => mp.track(event, { ...clean, ...mixpanelProps }));
}

export { failureReason, screenFromSegments };

export function identifyUser(id: string, email?: string | null): void {
  try {
    if (!id || id === "undefined" || id === "null") return;
    if (identifiedId && identifiedId !== id) {
      posthog?.reset();
      onMixpanel((mp) => mp.reset());
    }
    identifiedId = id;
    posthog?.identify(id, cleanProps({ email }));
    onMixpanel((mp) => {
      void mp.identify(id).catch(() => {});
      if (email) mp.getPeople().set("$email", email);
    });
  } catch {}
}

export function resetAnalytics(): void {
  try {
    posthog?.reset();
    onMixpanel((mp) => mp.reset());
    identifiedId = null;
  } catch {}
}

export function trackScreen(name: string, props?: EventProps): void {
  const clean = cleanProps(props);
  try {
    posthog?.screen(name, clean);
  } catch {}
  onMixpanel((mp) => mp.track("screen_viewed", { screen_name: name, ...clean, ...mixpanelProps }));
}
