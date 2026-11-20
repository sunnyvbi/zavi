import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import type { BrowserOAuthProvider } from "../auth/oauth";
import { palettes, type Colors } from "../theme/tokens";
import { useStyles, useTheme } from "../theme/theme";

type Props = {
  provider: BrowserOAuthProvider;
  busy: boolean;
  active: boolean;
  dock?: boolean;
  onPress: (provider: BrowserOAuthProvider) => void;
};

export function BrowserSignInButton({
  provider,
  busy,
  active,
  dock = false,
  onPress,
}: Props) {
  const themedStyles = useStyles(makeStyles);
  const { colors: themed } = useTheme();
  const styles = dock ? dockStyles : themedStyles;
  const colors = dock ? palettes.light : themed;
  return (
    <View style={!dock && styles.formRow}>
      <Pressable
        style={[styles.button, dock && styles.dockButton, busy && styles.busy]}
        onPress={() => onPress(provider)}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={
          provider === "github" ? "Continue with GitHub" : "Continue with Slack"
        }
        accessibilityState={{ disabled: busy, busy: active }}
      >
        {provider === "github" ? (
          <Svg width={20} height={20} viewBox="0 0 16 16" accessible={false}>
            <Path
              fill={colors.ink}
              d="M8 0C3.58 0 0 3.58 0 8a8 8 0 005.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
            />
          </Svg>
        ) : (
          <Svg
            width={20}
            height={20}
            viewBox="130 12.5 16 16"
            accessible={false}
          >
            <Path
              fill="#E01E5A"
              d="M133.351 22.5779C133.351 23.5 132.597 24.2532 131.675 24.2532C130.753 24.2532 130 23.5 130 22.5779C130 21.6558 130.753 20.9026 131.675 20.9026H133.351V22.5779ZM134.195 22.5779C134.195 21.6558 134.948 20.9026 135.87 20.9026C136.792 20.9026 137.545 21.6558 137.545 22.5779V26.7727C137.545 27.6948 136.792 28.448 135.87 28.448C134.948 28.448 134.195 27.6948 134.195 26.7727V22.5779Z"
            />
            <Path
              fill="#36C5F0"
              d="M135.87 15.8506C134.948 15.8506 134.195 15.0974 134.195 14.1753C134.195 13.2532 134.948 12.5 135.87 12.5C136.792 12.5 137.545 13.2532 137.545 14.1753V15.8506H135.87ZM135.87 16.6948C136.792 16.6948 137.545 17.4481 137.545 18.3701C137.545 19.2922 136.792 20.0455 135.87 20.0455H131.675C130.753 20.0455 130 19.2922 130 18.3701C130 17.4481 130.753 16.6948 131.675 16.6948H135.87Z"
            />
            <Path
              fill="#2EB67D"
              d="M142.649 18.3701C142.649 17.4481 143.403 16.6948 144.325 16.6948C145.247 16.6948 146 17.4481 146 18.3701C146 19.2922 145.247 20.0455 144.325 20.0455H142.649V18.3701ZM141.805 18.3701C141.805 19.2922 141.052 20.0455 140.13 20.0455C139.208 20.0455 138.455 19.2922 138.455 18.3701V14.1753C138.455 13.2532 139.208 12.5 140.13 12.5C141.052 12.5 141.805 13.2532 141.805 14.1753V18.3701Z"
            />
            <Path
              fill="#ECB22E"
              d="M140.13 25.1494C141.052 25.1494 141.805 25.9026 141.805 26.8247C141.805 27.7468 141.052 28.5 140.13 28.5C139.208 28.5 138.455 27.7468 138.455 26.8247V25.1494H140.13ZM140.13 24.3052C139.208 24.3052 138.455 23.552 138.455 22.6299C138.455 21.7078 139.208 20.9546 140.13 20.9546H144.325C145.247 20.9546 146 21.7078 146 22.6299C146 23.552 145.247 24.3052 144.325 24.3052H140.13Z"
            />
          </Svg>
        )}
        <Text style={styles.label}>
          {active
            ? "Redirecting…"
            : provider === "github"
              ? "Continue with GitHub"
              : "Continue with Slack"}
        </Text>
      </Pressable>
      {provider === "slack_oidc" ? (
        <Text style={[styles.hint, dock && styles.dockHint]}>
          Slack uses the active workspace in your browser. To use a different
          workspace, sign in to that Slack workspace in your browser before
          continuing.
        </Text>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  formRow: { marginTop: 10 },
  button: {
    minHeight: 53,
    borderRadius: 30,
    borderWidth: 1,
    borderColor: colors.form.edge,
    backgroundColor: colors.bg,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
    paddingVertical: 12,
    gap: 9,
  },
  dockButton: { minHeight: 51, borderRadius: 28, backgroundColor: "#ffffff" },
  label: {
    flexShrink: 1,
    textAlign: "center",
    fontFamily: "Inter_600SemiBold",
    includeFontPadding: false,
    fontSize: 15,
    color: colors.ink,
  },
  busy: { opacity: 0.6 },
  hint: {
    marginTop: 10,
    fontFamily: "Inter_400Regular",
    includeFontPadding: false,
    fontSize: 12,
    lineHeight: 18,
    color: colors.muted,
  },
  dockHint: { color: "#b8b8b8" },
});

const dockStyles = makeStyles(palettes.light);
