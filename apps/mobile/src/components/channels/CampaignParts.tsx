import { useRef, useState, type ReactNode } from "react";
import * as Crypto from "expo-crypto";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Icon } from "../Icon";
import { ZaviTextField } from "../ZaviTextField";
import { campaignFetch } from "../../features/channels/managedCampaignsHooks";
import { requestKey, type SaveRequest } from "../../features/channels/managedCampaigns";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

const newId = (): string => Crypto.randomUUID();

export function useSaver() {
  const key = useRef<{ signature: string; id: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save<T = unknown>(req: SaveRequest): Promise<T | null> {
    if (busy) return null;
    key.current = requestKey(key.current, req.path, req.body, newId);
    setBusy(true);
    setError(null);
    try {
      return await campaignFetch<T>(req.path, { method: "POST", body: req.body, requestId: key.current.id });
    } catch (e) {
      setError(e instanceof Error ? e.message : "The request could not be completed. Refresh before retrying.");
      return null;
    } finally {
      setBusy(false);
    }
  }
  return { save, busy, error, clearError: () => setError(null) };
}

export function Field({
  label,
  value,
  onChangeText,
  hint,
  keyboardType,
  multiline,
  placeholder,
  editable = true,
  maxLength,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  hint?: string;
  keyboardType?: "default" | "decimal-pad" | "url" | "numbers-and-punctuation";
  multiline?: boolean;
  placeholder?: string;
  editable?: boolean;
  maxLength?: number;
}) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.field}>
      <ZaviTextField inSheet title={label} value={value} onChangeText={onChangeText} editable={editable} placeholder={placeholder} keyboardType={keyboardType} multiline={!!multiline} maxLength={maxLength} autoCapitalize="none" autoCorrect={false} accessibilityLabel={label} />
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

export function Pills({ label, options, value, onPick }: { label: string; options: Array<{ value: string; label: string }>; value: string; onPick: (v: string) => void }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.pills}>
        {options.map((o) => (
          <Pressable key={o.value} style={[styles.pill, o.value === value && styles.pillOn]} onPress={() => onPick(o.value)} accessibilityRole="button" accessibilityState={{ selected: o.value === value }}>
            <Text style={[styles.pillText, o.value === value && styles.pillTextOn]}>{o.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

export function CheckRow({ label, checked, onPress, disabled }: { label: string; checked: boolean; onPress: () => void; disabled?: boolean }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <Pressable style={[styles.check, checked && styles.checkOn]} onPress={onPress} disabled={disabled} accessibilityRole="checkbox" accessibilityState={{ checked, disabled: !!disabled }}>
      <View style={[styles.box, checked && styles.boxOn]}>{checked ? <Icon name="tick" size={13} color={colors.onInk} /> : null}</View>
      <Text style={styles.checkText}>{label}</Text>
    </Pressable>
  );
}

export function Group({ title, children }: { title: string; children: ReactNode }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.group}>
      <Text style={styles.caps}>{title}</Text>
      {children}
    </View>
  );
}

export const toggle = (list: string[], id: string): string[] => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    field: { gap: 6 },
    label: { fontFamily: font.family.medium, fontSize: 14, color: colors.ink },
    input: { minHeight: 42, paddingHorizontal: space.md, paddingVertical: 10, fontFamily: font.family.medium, fontSize: 15, color: colors.ink },
    multiline: { minHeight: 80, textAlignVertical: "top" },
    off: { opacity: 0.5 },
    hint: { fontFamily: font.family.regular, fontSize: 12, lineHeight: 17, color: colors.muted },
    pills: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
    pill: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line },
    pillOn: { borderColor: colors.ink, backgroundColor: colors.ink },
    pillText: { fontFamily: font.family.medium, fontSize: 13, color: colors.ink },
    pillTextOn: { color: colors.onInk },
    check: { flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md },
    checkOn: { borderColor: colors.ink },
    checkText: { flex: 1, minWidth: 0, fontFamily: font.family.medium, fontSize: 14, lineHeight: 19, color: colors.ink },
    box: { width: 20, height: 20, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.line, borderRadius: 6 },
    boxOn: { borderColor: colors.ink, backgroundColor: colors.ink },
    group: { gap: space.sm },
    caps: { fontFamily: font.family.semi, fontSize: 11, letterSpacing: 0.66, textTransform: "uppercase", color: colors.muted },
  });
