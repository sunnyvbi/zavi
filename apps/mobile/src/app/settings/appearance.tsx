import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Screen } from "../../components/Screen";
import { Icon, type IconName } from "../../components/Icon";
import {
  BackHeader,
  ListGroup,
  SectionLabel,
  settingsStyles,
} from "../../components/settings/SettingsUI";
import {
  useAppearance,
  type AppearancePreference,
} from "../../lib/appearance";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

const OPTIONS: {
  value: AppearancePreference;
  label: string;
  icon: IconName;
}[] = [
  { value: "system", label: "System", icon: "smartphone" },
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
];

function systemLabel(scheme: "light" | "dark" | null): string {
  const device = Platform.OS === "ios" ? "iPhone" : "phone";
  if (!scheme) return `Match your ${device}`;
  return `Match your ${device} (${scheme === "light" ? "Light" : "Dark"} right now)`;
}

function subLabel(value: AppearancePreference, systemScheme: "light" | "dark" | null): string {
  if (value === "system") return systemLabel(systemScheme);
  if (value === "light") return "Always light";
  return "Always dark";
}

export default function AppearanceScreen() {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { preference, setPreference, systemScheme } = useAppearance();

  return (
    <Screen>
      <BackHeader title="Appearance" />
      <ScrollView
        contentContainerStyle={[settingsStyles.content, { paddingBottom: insets.bottom + 20 }]}
      >
        <SectionLabel first>Theme</SectionLabel>
        <ListGroup>
          {OPTIONS.map((option) => {
            const checked = preference === option.value;
            return (
              <Pressable
                key={option.value}
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                onPress={() => setPreference(option.value)}
                accessibilityRole="radio"
                accessibilityState={{ checked }}
                accessibilityLabel={option.label}
              >
                <Icon name={option.icon} size={20} color={colors.ink} />
                <View style={styles.rowText}>
                  <Text style={styles.rowTitle}>{option.label}</Text>
                  <Text style={styles.rowSub}>{subLabel(option.value, systemScheme)}</Text>
                </View>
                <View style={[styles.radio, checked && styles.radioOn]}>
                  {checked ? <View style={styles.radioDot} /> : null}
                </View>
              </Pressable>
            );
          })}
        </ListGroup>

        {}
        <SectionLabel>Preview</SectionLabel>
        <View
          style={[
            styles.preview,
            {
              backgroundColor: colors.bg,
              borderColor: colors.line,
            },
          ]}
        >
          <View
            style={[
              styles.bubble,
              { backgroundColor: colors.bubbleUserBg },
            ]}
          >
            <Text
              style={[
                styles.bubbleText,
                { color: colors.bubbleUserText },
              ]}
            >
              Why did bookings dip last week?
            </Text>
          </View>
          <Text
            style={[
              styles.reply,
              { color: colors.ink },
            ]}
          >
            Bookings fell 11% week over week. Almost all of it is Los Angeles.
          </Text>
        </View>

        <Text style={styles.footer}>Changes apply right away on this phone only.</Text>
      </ScrollView>
    </Screen>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  row: {
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    padding: space.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    marginBottom: -1,
    backgroundColor: colors.panel,
  },
  rowPressed: { backgroundColor: colors.soft },
  rowText: { flex: 1, minWidth: 0 },
  rowTitle: {
    fontFamily: font.family.semi,
    fontSize: font.size.base,
    lineHeight: 18,
    color: colors.ink,
    includeFontPadding: false,
  },
  rowSub: {
    marginTop: 2,
    fontFamily: font.family.medium,
    fontSize: font.size.sm,
    lineHeight: 16,
    color: colors.muted,
    includeFontPadding: false,
  },
  radio: {
    width: 20,
    height: 20,
    borderRadius: radius.pill,
    borderWidth: 2,
    borderColor: colors.switchOff,
    alignItems: "center",
    justifyContent: "center",
  },
  radioOn: { borderColor: colors.ink },
  radioDot: {
    width: 10,
    height: 10,
    borderRadius: radius.pill,
    backgroundColor: colors.ink,
  },
  preview: {
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: space.lg,
  },
  bubble: {
    maxWidth: "80%",
    alignSelf: "flex-end",
    borderRadius: 16,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  bubbleText: {
    fontFamily: font.family.regular,
    fontSize: font.size.md,
    lineHeight: 18,
    includeFontPadding: false,
  },
  reply: {
    marginTop: space.md,
    fontFamily: font.family.regular,
    fontSize: font.size.md,
    lineHeight: 18,
    includeFontPadding: false,
  },
  footer: {
    marginTop: space.md,
    fontFamily: font.family.regular,
    fontSize: font.size.sm,
    lineHeight: 16,
    color: colors.muted,
    includeFontPadding: false,
  },
});
