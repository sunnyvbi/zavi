import { useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Image,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { UnderlinedText } from "../UnderlinedText";
import { KeyboardAvoider } from "../KeyboardAvoider";
import { hintText } from "../ZaviTextField";
import { useKeyboardOpen } from "../useKeyboardReveal";
import { font, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";
import { PasswordEye } from "./PasswordEye";
import { BackIcon } from "../Icon";
const BRAND_RATIO = 63 / 25.6639;
const BRAND_HEIGHT = 24;
const TITLE_SIZE = 27;

export function AuthShell({
  onBack,
  eyebrow,
  title,
  sub,
  children,
  cta,
  onCta,
  busy,
  ctaDisabled,
}: {
  onBack?: () => void;
  eyebrow?: string;
  title: string;
  sub?: ReactNode;
  children?: ReactNode;
  cta?: string;
  onCta?: () => void;
  busy?: boolean;
  ctaDisabled?: boolean;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const keyboardOpen = useKeyboardOpen();
  const off = !!busy || !!ctaDisabled;
  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <KeyboardAvoider style={styles.flex}>
        <View style={styles.nav}>
          {onBack ? (
            <Pressable
              style={styles.back}
              onPress={() => {
                Keyboard.dismiss();
                onBack();
              }}
              disabled={busy}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Back"
            >
              <BackIcon />
            </Pressable>
          ) : null}
        </View>

        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Image
            source={require("../../../assets/images/zavi-wordmark.png")}
            style={styles.brand}
            resizeMode="contain"
            accessibilityLabel="Zavi"
          />
          {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
          <Text style={styles.title} accessibilityRole="header">
            {title}
          </Text>
          {sub ? <Text style={styles.sub}>{sub}</Text> : null}
          {children}
        </ScrollView>

        {cta && onCta ? (
          <View style={[styles.footer, { paddingBottom: 8 + (keyboardOpen ? 0 : insets.bottom) }]}>
            <Pressable
              style={[styles.primary, off && styles.primaryOff]}
              onPress={onCta}
              disabled={off}
              accessibilityRole="button"
              accessibilityState={{ disabled: off, busy: !!busy }}
            >
              {busy ? (
                <ActivityIndicator color={colors.onInk} />
              ) : (
                <Text style={styles.primaryText}>{cta}</Text>
              )}
            </Pressable>
          </View>
        ) : null}
      </KeyboardAvoider>
    </SafeAreaView>
  );
}

export function AuthWaiting({ label }: { label: string }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <SafeAreaView style={[styles.safe, styles.waiting]}>
      <ActivityIndicator color={colors.ink} />
      <Text style={styles.waitingText}>{label}</Text>
    </SafeAreaView>
  );
}

export function AuthField({
  label,
  error,
  secure,
  hint,
  ...input
}: TextInputProps & { label: string; error?: string | null; secure?: boolean; hint?: string }) {
  const styles = useStyles(makeStyles);
  const { colors, textSelectionColor, keyboardAppearance } = useTheme();
  const [focused, setFocused] = useState(false);
  const [visible, setVisible] = useState(false);
  return (
    <>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.fieldWrap}>
        {focused ? <View style={styles.ring} pointerEvents="none" /> : null}
        <TextInput
          keyboardAppearance={keyboardAppearance}
          placeholderTextColor={colors.form.placeholder}
          autoCapitalize="none"
          autoCorrect={false}
          cursorColor={colors.ink}
          selectionColor={textSelectionColor}
          selectionHandleColor={colors.ink}
          secureTextEntry={secure && !visible}
          {...input}
          placeholder={hintText(input.placeholder)}
          style={[styles.input, secure && styles.inputWithToggle, focused && styles.inputFocused]}
          onFocus={(e) => {
            setFocused(true);
            input.onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            input.onBlur?.(e);
          }}
        />
        {secure ? (
          <Pressable
            style={styles.toggle}
            onPress={() => setVisible((v) => !v)}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel={visible ? "Hide password" : "Show password"}
          >
            <PasswordEye visible={visible} empty={!input.value} />
          </Pressable>
        ) : null}
      </View>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </>
  );
}

export function AuthError({ children }: { children: string }) {
  const styles = useStyles(makeStyles);
  return (
    <Text style={styles.error} accessibilityLiveRegion="polite">
      {children}
    </Text>
  );
}

export function AuthNote({ children }: { children: ReactNode }) {
  const styles = useStyles(makeStyles);
  return <Text style={styles.note}>{children}</Text>;
}

export function AuthLink({
  lead,
  label,
  onPress,
  disabled,
}: {
  lead?: string;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const styles = useStyles(makeStyles);
  return (
    <Pressable
      style={styles.link}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={lead ? `${lead}${label}` : label}
    >
      <View style={styles.linkRow}>
        {lead ? <Text style={[styles.linkText, styles.linkLead]}>{lead}</Text> : null}
        <UnderlinedText style={[styles.linkText, styles.linkStrong]}>{label}</UnderlinedText>
      </View>
    </Pressable>
  );
}

export const makeAuthStyles = (colors: Colors) => StyleSheet.create({
  strong: { fontFamily: "Inter_600SemiBold", color: colors.ink },
});

const makeStyles = (colors: Colors, dark: boolean) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  waiting: { alignItems: "center", justifyContent: "center", gap: 12 },
  waitingText: {
    fontFamily: "Inter_600SemiBold",
    includeFontPadding: false,
    fontSize: 15,
    color: colors.muted,
  },
  nav: { height: 57, justifyContent: "center", paddingHorizontal: 16 },
  back: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.form.panel,
    alignItems: "center",
    justifyContent: "center",
  },
  body: { paddingHorizontal: 16, paddingTop: 20, paddingBottom: 20 },
  brand: {
    alignSelf: "center",
    width: Math.round(BRAND_HEIGHT * BRAND_RATIO),
    height: BRAND_HEIGHT,
    marginTop: 8,
    marginBottom: 24,
    ...(dark ? { tintColor: colors.ink } : null),
  },
  eyebrow: {
    textAlign: "center",
    fontFamily: "Inter_600SemiBold",
    includeFontPadding: false,
    fontSize: font.size.sm,
    letterSpacing: 1,
    textTransform: "uppercase",
    color: colors.muted,
    marginBottom: 8,
  },
  title: {
    textAlign: "center",
    fontFamily: "Inter_700Bold",
    includeFontPadding: false,
    fontSize: TITLE_SIZE,
    lineHeight: Math.round(TITLE_SIZE * 1.12),
    letterSpacing: -1.2,
    color: colors.ink,
    marginBottom: 13,
  },
  sub: {
    textAlign: "center",
    fontFamily: "Inter_400Regular",
    includeFontPadding: false,
    fontSize: font.size.base,
    lineHeight: 21,
    color: colors.muted,
  },
  label: {
    marginTop: 24,
    marginBottom: 6,
    fontFamily: font.family.medium,
    includeFontPadding: false,
    fontSize: 14,
    color: colors.ink,
  },
  fieldWrap: { position: "relative" },
  ring: {
    position: "absolute",
    top: -3,
    left: -3,
    right: -3,
    bottom: -3,
    borderWidth: 6,
    borderColor: colors.form.ring,
    borderRadius: 15,
  },
  input: {
    height: 48,
    borderWidth: 1,
    borderColor: colors.form.edge,
    borderRadius: 12,
    backgroundColor: colors.bg,
    paddingHorizontal: 12,
    fontFamily: font.family.medium,
    includeFontPadding: false,
    fontSize: 15,
    letterSpacing: 0,
    color: colors.ink,
  },
  inputFocused: { borderColor: colors.field.borderActive },
  inputWithToggle: { paddingRight: 40 },
  toggle: {
    position: "absolute",
    right: 0,
    top: 0,
    bottom: 0,
    width: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  hint: {
    marginTop: 8,
    fontFamily: "Inter_400Regular",
    includeFontPadding: false,
    fontSize: font.size.sm,
    lineHeight: 17,
    color: colors.muted,
  },
  error: {
    marginTop: 10,
    fontFamily: "Inter_400Regular",
    includeFontPadding: false,
    color: colors.red,
    fontSize: font.size.sm,
    lineHeight: 17,
  },
  note: {
    marginTop: 14,
    fontFamily: "Inter_400Regular",
    includeFontPadding: false,
    fontSize: 13,
    lineHeight: 19,
    color: colors.muted,
  },
  link: { minHeight: 44, alignItems: "center", justifyContent: "center", marginTop: 12 },
  linkRow: { flexDirection: "row", alignItems: "baseline" },
  linkText: {
    fontFamily: "Inter_500Medium",
    includeFontPadding: false,
    fontSize: font.size.sm,
    color: colors.ink,
  },
  linkLead: { fontFamily: "Inter_400Regular", color: colors.muted },
  linkStrong: { fontFamily: "Inter_600SemiBold", color: colors.ink },
  footer: { paddingHorizontal: 16, paddingTop: 12, backgroundColor: colors.bg },
  primary: {
    height: 53,
    borderRadius: 30,
    backgroundColor: colors.ink,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryOff: { opacity: 0.6 },
  primaryText: {
    fontFamily: "Inter_600SemiBold",
    includeFontPadding: false,
    fontSize: 15,
    color: colors.onInk,
  },
});
