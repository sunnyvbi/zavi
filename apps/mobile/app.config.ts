import type { ConfigContext, ExpoConfig } from "expo/config";

export default ({ config }: ConfigContext): ExpoConfig => {
  const iosClientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
  const googleUrlScheme = iosClientId
    ? `com.googleusercontent.apps.${iosClientId.replace(".apps.googleusercontent.com", "")}`
    : null;
  return {
    ...config,
    name: config.name ?? "Zavi",
    slug: config.slug ?? "zavi",
    ios: {
      ...config.ios,
      ...(googleUrlScheme ? { scheme: googleUrlScheme } : {}),
    },
  };
};
