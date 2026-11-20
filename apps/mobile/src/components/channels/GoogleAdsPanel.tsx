import { useState } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { Icon } from "../Icon";
import { SpinningIcon } from "../SpinningIcon";
import { OptionSheet } from "../OptionSheet";
import { TextLink } from "../growth/StoryKit";
import { ConnectControl } from "../connect/ConnectControl";
import { CardButton } from "../reply/ui";
import { FocusRing } from "../ZaviTextField";
import {
  DEFAULT_RANGES,
  count,
  errorBanner,
  money,
  parseBudget,
  periodLabel,
  planEditLabel,
  planLine,
  roas,
  statusChip,
  type GadsCampaign,
  type GadsPacing,
  type GadsPayload,
  type GadsRange,
} from "../../features/channels/googleAds";
import { saveMonthlyPlan } from "../../features/channels/googleAdsHooks";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

const open = (url: string) => void WebBrowser.openBrowserAsync(url).catch(() => Linking.openURL(url).catch(() => {}));

export function GoogleAdsControls({
  payload,
  range,
  onRange,
  onRefresh,
  onReconnected,
}: {
  payload: GadsPayload | undefined;
  range: GadsRange;
  onRange: (id: string) => void;
  onRefresh: () => Promise<unknown>;
  onReconnected: () => void;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const [picking, setPicking] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const ranges = payload?.ranges?.length ? payload.ranges : DEFAULT_RANGES;
  const connected = !!payload?.connected;
  const banner = payload ? errorBanner(payload) : null;

  const refresh = async () => {
    setRefreshing(true);
    try {
      await onRefresh();
    } catch {
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <View style={styles.wrap}>
      {connected ? (
        <View style={styles.controls}>
          <Pressable
            style={({ pressed }) => [styles.select, pressed && styles.pressed]}
            onPress={() => setPicking(true)}
            accessibilityRole="button"
            accessibilityLabel={`Date range: ${range.label}`}
          >
            <Icon name="calendarList" size={16} color={colors.muted} />
            <Text style={styles.selectText} numberOfLines={1}>
              {periodLabel(range, payload?.period)}
            </Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.refresh, pressed && styles.pressed, refreshing && styles.dim]}
            onPress={() => void refresh()}
            disabled={refreshing}
            accessibilityRole="button"
            accessibilityLabel={refreshing ? "Reading" : "Refresh"}
          >
            <SpinningIcon name="refresh" size={17} color={colors.ink} spinning={refreshing} />
          </Pressable>
        </View>
      ) : null}

      {banner ? (
        <View style={[styles.banner, banner.kind === "reconnect" && styles.bannerBad]} accessibilityRole="alert">
          <Text style={styles.bannerText}>{banner.text}</Text>
          {banner.kind === "reconnect" ? (
            <View style={styles.bannerButton}>
              <ConnectControl slug="google_ads" mode="reconnect" buttonLabel="Reconnect" onAttempted={onReconnected} />
            </View>
          ) : null}
        </View>
      ) : null}

      <OptionSheet
        open={picking}
        title="Date range"
        options={ranges.map((r) => ({ value: r.id, label: r.label }))}
        value={range.id}
        onPick={onRange}
        onClose={() => setPicking(false)}
      />
    </View>
  );
}

export function GoogleAdsPlan({ pacing, onSaved }: { pacing: GadsPacing; onSaved: () => Promise<unknown> | void }) {
  const styles = useStyles(makeStyles);
  const { colors, textSelectionColor } = useTheme();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(pacing.plan ? String(Math.round(pacing.plan)) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (usd: number | null) => {
    setBusy(true);
    setError(null);
    const err = await saveMonthlyPlan(usd);
    setBusy(false);
    if (err) {
      setError(err);
      return;
    }
    setEditing(false);
    await onSaved();
  };

  const submit = () => {
    const n = parseBudget(draft);
    if (n === null) {
      setError("Enter a monthly amount in dollars.");
      return;
    }
    void save(n);
  };

  return (
    <View style={styles.plan}>
      <Text style={styles.small}>{planLine(pacing)}</Text>
      {editing ? (
        <View style={styles.planForm}>
          <FocusRing radius={radius.sm}>
            {(focus) => (
              <TextInput
                value={draft}
                onChangeText={setDraft}
                keyboardType="decimal-pad"
                accessibilityLabel="Monthly plan in dollars"
                style={styles.planInput}
                editable={!busy}
                selectionColor={textSelectionColor}
                cursorColor={colors.ink}
                selectionHandleColor={colors.ink}
                onFocus={focus.onFocus}
                onBlur={focus.onBlur}
              />
            )}
          </FocusRing>
          <CardButton label="Save" onPress={submit} busy={busy} />
          {pacing.plan_basis === "founder" ? (
            <CardButton label="Use daily budgets" variant="secondary" onPress={() => void save(null)} disabled={busy} />
          ) : null}
        </View>
      ) : (
        <TextLink label={planEditLabel(pacing)} onPress={() => setEditing(true)} />
      )}
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const COLUMNS: Array<{ label: string; width: number; right?: boolean }> = [
  { label: "Campaign", width: 150 },
  { label: "Status", width: 78 },
  { label: "Spend", width: 84, right: true },
  { label: "Conv.", width: 70, right: true },
  { label: "CPA", width: 84, right: true },
  { label: "Conv. value", width: 100, right: true },
];

export function GoogleAdsCampaigns({ payload }: { payload: GadsPayload }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const t = payload.totals;
  const cell = (i: number) => [styles.cell, { width: COLUMNS[i].width }, i > 0 && styles.cellDivider];
  return (
    <View style={styles.card}>
      <View style={styles.tableHead}>
        <Icon name="chartColumn" size={16} color={colors.ink} />
        <Text style={styles.cardTitle}>Campaign performance</Text>
      </View>
      {payload.campaigns.length === 0 ? (
        <Text style={styles.empty}>No campaign spent or ran in this period.</Text>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.bleed} contentContainerStyle={styles.bleedInner}>
          <View style={styles.grid}>
            <View style={[styles.gridRow, styles.gridHead]}>
              {COLUMNS.map((c, i) => (
                <View key={c.label} style={cell(i)}>
                  <Text style={[styles.headText, c.right && styles.right]}>{c.label}</Text>
                </View>
              ))}
            </View>
            {payload.campaigns.map((c) => {
              const chip = statusChip(c);
              const values = [money(c.spend), count(c.conversions), money(c.cpa, true), money(c.conv_value)];
              return (
                <View key={c.id} style={[styles.gridRow, styles.rowDivider]}>
                  <View style={cell(0)}>
                    {c.url ? (
                      <Pressable onPress={() => open(c.url as string)} accessibilityRole="link" hitSlop={4}>
                        <Text style={styles.linkText} numberOfLines={3}>
                          {c.name}
                        </Text>
                      </Pressable>
                    ) : (
                      <Text style={styles.cellText} numberOfLines={3}>
                        {c.name}
                      </Text>
                    )}
                  </View>
                  <View style={cell(1)}>
                    <Text style={[styles.chip, chip.tone === "good" ? styles.chipGood : chip.tone === "warn" ? styles.chipWarn : styles.chipMuted]}>
                      {chip.label}
                    </Text>
                  </View>
                  {values.map((v, i) => (
                    <View key={i} style={cell(i + 2)}>
                      <Text style={[styles.cellText, i > 0 && styles.dimText, styles.right]}>{v}</Text>
                    </View>
                  ))}
                </View>
              );
            })}
            {t ? (
              <View style={[styles.gridRow, styles.rowDivider, styles.gridHead]}>
                {[
                  `${t.campaigns} ${t.campaigns === 1 ? "campaign" : "campaigns"}`,
                  `ROAS ${roas(t.roas)}`,
                  money(t.spend),
                  count(t.conversions),
                  money(t.cpa, true),
                  money(t.conv_value),
                ].map((f, i) => (
                  <View key={i} style={cell(i)}>
                    <Text style={[styles.footText, COLUMNS[i].right && styles.right]}>{f}</Text>
                  </View>
                ))}
              </View>
            ) : null}
          </View>
        </ScrollView>
      )}
      <Text style={styles.small}>Numbers as reported by Google Ads.</Text>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    wrap: { gap: space.md },
    controls: { flexDirection: "row", alignItems: "center", gap: space.sm, marginTop: space.md },
    select: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      minHeight: 40,
      paddingHorizontal: space.md,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radius.sm,
    },
    selectText: { flex: 1, fontFamily: font.family.medium, fontSize: 13, color: colors.ink },
    refresh: {
      width: 40,
      height: 40,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radius.sm,
    },
    pressed: { opacity: 0.6 },
    dim: { opacity: 0.5 },
    banner: { gap: space.sm, padding: space.md, borderRadius: radius.md, backgroundColor: colors.soft },
    bannerBad: { backgroundColor: colors.status.redBg },
    bannerText: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 19, color: colors.ink },
    bannerButton: { alignSelf: "flex-start" },
    small: { fontFamily: font.family.regular, fontSize: 12, lineHeight: 17, color: colors.muted },
    plan: { marginTop: space.md, gap: space.sm },
    planForm: { gap: space.sm },
    planInput: {
      minHeight: 44,
      paddingHorizontal: space.md,
      fontFamily: font.family.medium,
      fontSize: 15,
      color: colors.ink,
    },
    error: { fontFamily: font.family.medium, fontSize: 12, lineHeight: 17, color: colors.red },
    card: {
      marginTop: space.md,
      padding: space.lg,
      gap: space.sm,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: 16,
      backgroundColor: colors.panel,
    },
    cardTitle: { fontFamily: font.family.semi, fontSize: 15, color: colors.ink },
    empty: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 19, color: colors.muted },
    tableHead: { flexDirection: "row", alignItems: "center", gap: space.sm },
    bleed: { marginHorizontal: -space.lg },
    bleedInner: { paddingHorizontal: space.lg },
    grid: { borderWidth: 1, borderColor: colors.line, borderRadius: 10, overflow: "hidden" },
    gridRow: { flexDirection: "row" },
    gridHead: { backgroundColor: colors.soft },
    rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
    cell: { paddingHorizontal: 10, paddingVertical: 8, gap: 4 },
    cellDivider: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.line },
    headText: { fontFamily: font.family.semi, fontSize: 13, color: colors.ink },
    footText: { fontFamily: font.family.semi, fontSize: 13, color: colors.textSecondary },
    right: { textAlign: "right" },
    cellText: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 19, color: colors.ink },
    dimText: { color: colors.muted },
    linkText: { fontFamily: font.family.semi, fontSize: 13, lineHeight: 18, color: colors.ink },
    chip: {
      alignSelf: "flex-start",
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: radius.pill,
      overflow: "hidden",
      fontFamily: font.family.semi,
      fontSize: 12,
    },
    chipGood: { backgroundColor: colors.status.greenBg, color: colors.status.greenText },
    chipWarn: { backgroundColor: colors.status.amberBg, color: colors.status.amberText },
    chipMuted: { backgroundColor: colors.soft, color: colors.textSecondary },
  });
