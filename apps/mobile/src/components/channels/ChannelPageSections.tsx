import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Animated, Easing, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import {
  planEditable,
  planWritten,
  emptyTiles,
  statusLine,
  type ChannelPlan,
  type DrawerRow,
  type MetricTile,
  type RunDrawer,
} from "../../features/channels/channelPage";
import { useReduceMotion } from "../../lib/motion";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";
import { Icon } from "../Icon";
import { SkeletonBlock } from "../Skeleton";
import { metricIcon } from "../../features/channels/metricIcons";
import { UnderlinedText } from "../UnderlinedText";
import { ChannelLogo } from "./ChannelGlyph";
import { ConnectControl } from "../connect/ConnectControl";
import { connectorLabel } from "../../features/connectors/catalog";
import { StatusSpinner } from "./ChannelStates";
import { FocusRing } from "../ZaviTextField";

export function ChannelHero({ slug, name }: { slug: string; name: string }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.hero}>
      <ChannelLogo slug={slug} size={48} />
      <View style={styles.heroText}>
        <Text style={styles.heroName} numberOfLines={1}>
          {name}
        </Text>
      </View>
    </View>
  );
}

export function ConnectStrip({
  slug,
  name,
  connectors,
  onAttempted,
}: {
  slug: string;
  name: string;
  connectors: readonly string[];
  onAttempted: () => void;
}) {
  const styles = useStyles(makeStyles);
  const names = [...new Set(connectors.map(connectorLabel))];
  const first = connectors[0];
  return (
    <View style={styles.connect}>
      <View style={styles.connectHead}>
        <ChannelLogo slug={slug} size={36} />
        <View style={styles.connectText}>
          <Text style={styles.connectTitle}>{`Connect ${names.length ? names.join(" or ") : name}`}</Text>
          <Text style={styles.small}>
            Zavi reads your account so its advice uses your real numbers. Nothing changes in your account without your approval.
          </Text>
        </View>
      </View>
      {first ? (
        <View style={styles.connectButton}>
          <ConnectControl
            slug={first}
            buttonLabel="Connect"
            fallback={{ connect: "oauth", label: connectorLabel(first), settingsAnchor: null }}
            onAttempted={onAttempted}
          />
        </View>
      ) : null}
    </View>
  );
}

export function NumbersCard({
  slug,
  tiles,
  connected,
  needsConnect,
  connectors,
  loading,
  selectable,
  selectedKey,
  onSelect,
}: {
  slug: string;
  tiles: MetricTile[];
  connected: boolean;
  needsConnect: boolean;
  connectors: readonly string[];
  loading: boolean;
  selectable?: ReadonlySet<string>;
  selectedKey?: string | null;
  onSelect?: (key: string) => void;
}) {
  const styles = useStyles(makeStyles);
  const lead = tiles[0];
  const rest = tiles.slice(1);
  const blank = !loading && !lead ? emptyTiles(slug, connected || !needsConnect) : [];
  const names = [...new Set(connectors.map(connectorLabel))];
  const empty = `Nothing has written numbers here yet. ${
    needsConnect && !connected
      ? `Connect ${names.length ? names.join(" or ") : "an account"} and Zavi records them on its next run.`
      : "Zavi records them when a run measures this channel."
  }`;
  const pickable = (key: string) => !!(selectable?.has(key) && onSelect);

  const leadBody = lead ? (
    <>
      <TileLabel metricKey={lead.key} label={lead.label} />
      <View style={styles.leadRow}>
        <Text style={[styles.leadValue, toneStyle(styles, lead.tone)]}>
          {lead.value}
          {lead.suffix ? <Text style={styles.suffix}>{lead.suffix}</Text> : null}
        </Text>
        {lead.delta ? <DeltaPill delta={lead.delta} /> : null}
        {lead.unverified ? <Text style={styles.unverified}>unverified</Text> : null}
      </View>
      {lead.unmeasured || lead.note ? <Text style={styles.small}>{lead.unmeasured ?? lead.note}</Text> : null}
    </>
  ) : null;

  return (
    <View style={styles.numbers}>
      <Text style={styles.numbersTitle} accessibilityRole="header">
        How the account is doing
      </Text>
      {loading ? (
        <NumbersSkeleton tiles={Math.max(emptyTiles(slug, true).length - 1, 0) || 4} />
      ) : lead ? (
        <>
          {pickable(lead.key) ? (
            <Pressable
              onPress={() => onSelect?.(lead.key)}
              style={[styles.leadWrap, selectedKey === lead.key && styles.picked]}
              accessibilityRole="button"
              accessibilityState={{ selected: selectedKey === lead.key }}
              accessibilityLabel={`${lead.label}: show its table`}
            >
              {leadBody}
            </Pressable>
          ) : (
            leadBody
          )}
          {rest.length > 0 ? (
            <View style={styles.tiles}>
              {rest.map((t) => (
                <Pressable
                  key={t.key}
                  disabled={!pickable(t.key)}
                  onPress={() => onSelect?.(t.key)}
                  style={[styles.tile, selectedKey === t.key && styles.picked]}
                  accessibilityRole={pickable(t.key) ? "button" : undefined}
                  accessibilityState={pickable(t.key) ? { selected: selectedKey === t.key } : undefined}
                  accessibilityLabel={pickable(t.key) ? `${t.label}: show its table` : undefined}
                >
                  <TileLabel metricKey={t.key} label={t.label} />
                  <View style={styles.tileValueRow}>
                    <Text style={[styles.tileValue, toneStyle(styles, t.tone)]}>
                      {t.value}
                      {t.suffix ? <Text style={styles.suffix}>{t.suffix}</Text> : null}
                    </Text>
                    {t.delta ? (
                      <Text style={[styles.tileDelta, t.delta.good ? styles.good : styles.bad]} numberOfLines={1}>
                        {t.delta.text}
                      </Text>
                    ) : null}
                  </View>
                  {t.unmeasured || t.note ? (
                    <Text style={styles.tileNote} numberOfLines={2}>
                      {t.unmeasured ?? t.note}
                    </Text>
                  ) : null}
                </Pressable>
              ))}
            </View>
          ) : null}
        </>
      ) : blank.length > 0 ? (
        <>
          <View style={styles.tiles}>
            {blank.map((t) => (
              <View key={t.key} style={styles.tile}>
                <TileLabel metricKey={t.key} label={t.label} />
                <Text style={styles.tileUnmeasured}>{t.unmeasured}</Text>
              </View>
            ))}
          </View>
          {needsConnect && !connected ? <Text style={styles.small}>{empty.replace("Nothing has written numbers here yet. ", "")}</Text> : null}
        </>
      ) : (
        <Text style={styles.small}>{empty}</Text>
      )}
    </View>
  );
}

function NumbersSkeleton({ tiles }: { tiles: number }) {
  const styles = useStyles(makeStyles);
  return (
    <View accessible accessibilityLabel="Loading numbers" accessibilityState={{ busy: true }}>
      <SkeletonBlock width={64} height={10} style={styles.skelLabel} />
      <SkeletonBlock width={110} height={26} radius={6} style={styles.skelLead} />
      <View style={styles.tiles}>
        {Array.from({ length: tiles }, (_, i) => (
          <View key={i} style={styles.tile}>
            <SkeletonBlock width={72} height={10} />
            <SkeletonBlock width={52} height={16} style={styles.skelValue} />
          </View>
        ))}
      </View>
    </View>
  );
}

function TileLabel({ metricKey, label, lines = 1 }: { metricKey: string; label: string; lines?: number }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const icon = metricIcon(metricKey);
  return (
    <View style={styles.labelRow}>
      {icon ? <Icon name={icon} size={14} color={colors.muted} /> : null}
      <Text style={styles.tileLabel} numberOfLines={lines}>
        {label}
      </Text>
    </View>
  );
}

function toneStyle(styles: { toneGood: object; toneWarn: object; toneBad: object }, tone: MetricTile["tone"]) {
  return tone === "good" ? styles.toneGood : tone === "warn" ? styles.toneWarn : tone === "bad" ? styles.toneBad : null;
}

function DeltaPill({ delta }: { delta: NonNullable<MetricTile["delta"]> }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={[styles.pill, delta.good ? styles.pillGood : styles.pillBad]}>
      <Text style={[styles.pillText, delta.good ? styles.good : styles.bad]}>
        {`${delta.direction === "up" ? "▲" : "▼"} ${delta.text.replace(/^[+-]/, "")}`}
      </Text>
    </View>
  );
}

export function RunProgress({ working, waiting }: { working: boolean; waiting: number }) {
  const styles = useStyles(makeStyles);
  const status = statusLine({ working, waiting });
  if (!working) return null;
  return (
    <View style={styles.card}>
      <View style={styles.statusRow}>
        {status.tone === "working" ? <StatusSpinner /> : <View style={[styles.statusDot, styles.greyDotBg]} />}
        <Text style={styles.statusText}>{status.text}</Text>
      </View>
      <Text style={styles.small}>Usually a few minutes. You can leave this page.</Text>
      <ProgressBar />
    </View>
  );
}

export function RunButton({ run }: { run: { label: string; cost: string; disabled: boolean; busy: boolean; onPress: () => void } }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <View style={styles.runWrap}>
      <Pressable
        style={({ pressed }) => [styles.runButton, run.disabled && styles.disabled, pressed && !run.disabled && styles.pressed]}
        onPress={run.onPress}
        disabled={run.disabled}
        accessibilityRole="button"
        accessibilityState={{ disabled: run.disabled, busy: run.busy }}
      >
        {run.busy ? <ActivityIndicator size="small" color={colors.onInk} /> : null}
        <Text style={styles.runText}>{run.label}</Text>
      </Pressable>
      <Text style={styles.runCost}>{run.cost}</Text>
    </View>
  );
}

export function RunLog({ drawer }: { drawer: RunDrawer }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  if (drawer.total === 0) return null;
  const section = (title: string, rows: DrawerRow[], tone: "plain" | "archived", note?: string | null) =>
    rows.length > 0 ? (
      <View style={styles.logSection}>
        <Text style={styles.logSectionTitle}>{title.toUpperCase()}</Text>
        {note ? <Text style={styles.small}>{note}</Text> : null}
        {rows.map((r) => (
          <View key={r.id} style={[styles.logRow, tone === "archived" && styles.logRowArchived, r.failed && styles.logRowFailed]}>
            {r.id.startsWith("run:") ? <View style={[styles.logDot, r.failed ? styles.logDotFailed : styles.logDotOk]} /> : null}
            <View style={styles.logRowText}>
              <Text style={[styles.logRowTitle, tone === "archived" && styles.logRowTitleMuted]} numberOfLines={2}>
                {r.title}
              </Text>
              {r.line ? <Text style={[styles.small, r.failed && styles.bad]}>{r.line}</Text> : null}
              {r.note ? <Text style={styles.small}>{r.note}</Text> : null}
            </View>
          </View>
        ))}
      </View>
    ) : null;
  return (
    <View style={styles.logWrap}>
      <Pressable
        style={styles.logHead}
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
      >
        <Text style={styles.sectionTitle}>Runs and past items</Text>
        <View style={styles.logCount}>
          <Text style={styles.logCountText}>{drawer.total}</Text>
        </View>
        <View style={[styles.logChevron, open ? undefined : styles.chevClosed]}>
          <Icon name="chevron" size={20} color={colors.muted} />
        </View>
      </Pressable>
      {open ? (
        <View>
          {section("Runs", drawer.runs, "plain")}
          {section("Finished here", drawer.closed, "plain")}
          {section("Before the switch", drawer.preSwitch, "archived", drawer.preSwitchNote)}
        </View>
      ) : null}
    </View>
  );
}

export function ChannelTabBar<K extends string>({
  tabs,
  active,
  onSelect,
  count,
}: {
  tabs: ReadonlyArray<readonly [K, string]>;
  active: K;
  onSelect: (key: K) => void;
  count: number;
}) {
  const styles = useStyles(makeStyles);
  if (tabs.length < 2) return null;
  return (
    <View style={styles.tabs} accessibilityRole="tablist">
      {tabs.map(([key, label], i) => (
        <Pressable
          key={key}
          style={[styles.tab, active === key && styles.tabOn]}
          onPress={() => onSelect(key)}
          accessibilityRole="tab"
          accessibilityState={{ selected: active === key }}
        >
          <Text style={[styles.tabText, active === key && styles.tabTextOn]}>{label}</Text>
          {i === 0 && count > 0 ? (
            <View style={styles.countChip}>
              <Text style={styles.countText}>{count}</Text>
            </View>
          ) : null}
        </Pressable>
      ))}
    </View>
  );
}

export function PlanCard({
  name,
  plan,
  busy,
  onChange,
}: {
  name: string;
  plan: ChannelPlan;
  busy: boolean;
  onChange: (note: string) => Promise<boolean>;
}) {
  const styles = useStyles(makeStyles);
  const { colors, textSelectionColor } = useTheme();
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [note, setNote] = useState("");
  return (
    <View style={styles.card}>
      <View style={styles.planHead}>
        <Text style={styles.planTitle}>{`Your ${name} plan`}</Text>
        <Text style={styles.small}>{planWritten(plan.proposed_at)}</Text>
      </View>
      <Text style={styles.planBody} numberOfLines={expanded ? undefined : 6}>
        {plan.content}
      </Text>
      <Pressable style={styles.linkWrap} onPress={() => setExpanded((v) => !v)} hitSlop={6} accessibilityRole="button">
        <UnderlinedText style={styles.link}>{expanded ? "Show less" : "Show more"}</UnderlinedText>
      </Pressable>
      <Text style={styles.small}>Saved automatically. Every run drafts from this plan.</Text>
      {planEditable(plan) ? (
        open ? (
          <View style={styles.planEdit}>
            <Text style={styles.planEditLabel}>What should change?</Text>
            <FocusRing radius={radius.md}>
              {(focus) => (
                <TextInput
                  value={note}
                  onChangeText={setNote}
                  multiline
                  style={styles.input}
                  placeholderTextColor={colors.muted}
                  selectionColor={textSelectionColor}
                  cursorColor={colors.ink}
                  selectionHandleColor={colors.ink}
                  accessibilityLabel="What should change?"
                  onFocus={focus.onFocus}
                  onBlur={focus.onBlur}
                />
              )}
            </FocusRing>
            <View style={styles.row}>
              <Pressable
                style={({ pressed }) => [styles.darkButton, (busy || note.trim().length < 3) && styles.disabled, pressed && styles.pressed]}
                disabled={busy || note.trim().length < 3}
                onPress={() =>
                  void onChange(note.trim()).then((ok) => {
                    if (ok) {
                      setOpen(false);
                      setNote("");
                    }
                  })
                }
                accessibilityRole="button"
              >
                <Text style={styles.darkButtonText}>Write a new plan</Text>
              </Pressable>
              <Pressable style={styles.plainButton} onPress={() => setOpen(false)} accessibilityRole="button">
                <Text style={styles.plainButtonText}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <Pressable
            style={({ pressed }) => [styles.outlineButton, pressed && styles.pressed]}
            onPress={() => setOpen(true)}
            accessibilityRole="button"
          >
            <Text style={styles.plainButtonText}>Change plan</Text>
          </Pressable>
        )
      ) : null}
    </View>
  );
}

export function SectionHeader({ title, count }: { title: string; count?: number }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {count ? (
        <View style={styles.countChip}>
          <Text style={styles.countText}>{count}</Text>
        </View>
      ) : null}
    </View>
  );
}

function ProgressBar() {
  const styles = useStyles(makeStyles);
  const reduceMotion = useReduceMotion();
  const [width, setWidth] = useState(0);
  const slide = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduceMotion || width === 0) {
      slide.setValue(0);
      return;
    }
    const animation = Animated.loop(
      Animated.timing(slide, { toValue: 1, duration: 2000, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    );
    animation.start();
    return () => animation.stop();
  }, [reduceMotion, slide, width]);
  const barWidth = width * 0.35;
  const translateX = reduceMotion ? 0 : slide.interpolate({ inputRange: [0, 1], outputRange: [-barWidth, width] });
  return (
    <View
      style={styles.track}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Animated.View style={[styles.bar, { width: barWidth, transform: [{ translateX }] }]} />
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  hero: { flexDirection: "row", alignItems: "center", gap: space.md, paddingTop: space.sm },
  heroText: { flex: 1, minWidth: 0 },
  heroName: { fontFamily: font.family.semi, fontSize: 20, color: colors.ink },
  connect: {
    gap: space.md,
    marginTop: space.md,
    padding: space.md,
    borderRadius: 16,
    backgroundColor: colors.wire.page,
  },
  connectHead: { flexDirection: "row", alignItems: "center", gap: space.md },
  connectButton: { alignSelf: "flex-start" },
  connectText: { flex: 1, minWidth: 0, gap: 2 },
  connectTitle: { fontFamily: font.family.semi, fontSize: 14, color: colors.ink },
  card: {
    marginTop: space.md,
    padding: space.lg,
    gap: space.sm,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 16,
    backgroundColor: colors.panel,
  },
  caps: {
    fontFamily: font.family.semi,
    fontSize: 11,
    letterSpacing: 0.66,
    textTransform: "uppercase",
    color: colors.muted,
  },
  small: { fontFamily: font.family.regular, fontSize: 12, lineHeight: 17, color: colors.muted },
  body: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 19, color: colors.textSecondary },
  numbers: { marginTop: space.lg, gap: 0 },
  numbersTitle: { fontFamily: font.family.semi, fontSize: 17, letterSpacing: -0.2, color: colors.ink, marginBottom: 4 },
  leadWrap: { marginTop: 6, paddingHorizontal: 10, paddingVertical: 8, gap: 0, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line },
  picked: { borderColor: colors.ink },
  labelRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  leadRow: { flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" },
  leadValue: { fontFamily: font.family.semi, fontSize: 26, lineHeight: 30, color: colors.ink },
  unverified: { fontFamily: font.family.medium, fontSize: 11, color: colors.muted },
  pill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill },
  pillGood: { backgroundColor: colors.status.greenBg },
  pillBad: { backgroundColor: colors.status.redBg },
  pillText: { fontFamily: font.family.semi, fontSize: 12 },
  good: { color: colors.status.greenText },
  bad: { color: colors.status.redText },
  tiles: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 6 },
  tile: {
    width: "48%",
    flexGrow: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
    gap: 0,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
  },
  tileLabel: { fontFamily: font.family.regular, fontSize: 11, lineHeight: 15, color: colors.muted },
  tileValueRow: { flexDirection: "row", alignItems: "baseline", gap: 6 },
  tileValue: { fontFamily: font.family.semi, fontSize: 16, lineHeight: 21, color: colors.ink },
  tileDelta: { flexShrink: 1, fontFamily: font.family.medium, fontSize: 11 },
  skelLabel: { marginTop: 4 },
  skelLead: { marginTop: 6, marginBottom: 2 },
  skelValue: { marginTop: 6 },
  suffix: { fontFamily: font.family.regular, fontSize: 12, color: colors.muted },
  tileNote: { fontFamily: font.family.regular, fontSize: 11, lineHeight: 15, color: colors.muted },
  toneGood: { color: colors.status.greenText },
  toneWarn: { color: colors.status.amberText },
  toneBad: { color: colors.status.redText },
  tileUnmeasured: { fontFamily: font.family.regular, fontSize: 12, lineHeight: 17, color: colors.muted },
  statusRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  greenDotBg: { backgroundColor: colors.status.greenDot },
  greyDotBg: { backgroundColor: colors.wire.faint },
  statusText: { fontFamily: font.family.semi, fontSize: 14, color: colors.ink },
  track: { height: 3, borderRadius: 2, overflow: "hidden", backgroundColor: colors.line },
  bar: { height: 3, borderRadius: 2, backgroundColor: colors.status.greenDot },
  runWrap: { marginTop: space.sm, gap: 6 },
  runButton: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.ink,
  },
  runText: { fontFamily: font.family.semi, fontSize: 14, color: colors.onInk },
  runCost: { textAlign: "center", fontFamily: font.family.regular, fontSize: 12, color: colors.muted },
  planHead: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: space.sm },
  planTitle: { flexShrink: 1, fontFamily: font.family.semi, fontSize: 16, color: colors.ink },
  planBody: { fontFamily: font.family.regular, fontSize: 14, lineHeight: 21, color: colors.ink },
  linkWrap: { alignSelf: "flex-start" },
  link: { fontFamily: font.family.semi, fontSize: 13, color: colors.ink },
  planEdit: { gap: space.sm, marginTop: space.xs },
  planEditLabel: { fontFamily: font.family.medium, fontSize: 14, color: colors.ink },
  input: {
    minHeight: 84,
    padding: space.md,
    textAlignVertical: "top",
    fontFamily: font.family.medium,
    fontSize: 15,
    color: colors.ink,
  },
  row: { flexDirection: "row", alignItems: "center", gap: space.sm },
  darkButton: {
    minHeight: 40,
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
    backgroundColor: colors.ink,
  },
  darkButtonText: { fontFamily: font.family.semi, fontSize: 14, color: colors.onInk },
  outlineButton: {
    alignSelf: "flex-start",
    minHeight: 40,
    paddingHorizontal: 14,
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.pill,
    backgroundColor: colors.panel,
  },
  plainButton: { minHeight: 40, paddingHorizontal: 10, justifyContent: "center" },
  plainButtonText: { fontFamily: font.family.semi, fontSize: 14, color: colors.ink },
  sectionHeader: { flexDirection: "row", alignItems: "center", gap: space.sm, marginTop: space.lg + space.xs },
  sectionTitle: { fontFamily: font.family.semi, fontSize: 17, letterSpacing: -0.2, color: colors.ink },
  countChip: {
    minWidth: 20,
    height: 20,
    paddingHorizontal: 6,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.soft,
  },
  countText: { fontFamily: font.family.semi, fontSize: 12, color: colors.ink },
  logCount: { minWidth: 20, height: 20, paddingHorizontal: 6, borderRadius: radius.pill, alignItems: "center", justifyContent: "center", backgroundColor: colors.soft },
  logCountText: { fontFamily: font.family.medium, fontSize: 12, color: colors.muted },
  chevClosed: { transform: [{ rotate: "-90deg" }] },
  logWrap: { marginTop: space.lg + space.xs },
  logHead: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 44 },
  logChevron: { marginLeft: "auto" },
  logSection: { gap: space.sm, marginTop: space.md },
  logSectionTitle: { fontFamily: font.family.semi, fontSize: 12, letterSpacing: 0.5, color: colors.muted },
  logRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    backgroundColor: colors.bg,
  },
  logRowArchived: { backgroundColor: colors.soft },
  logRowFailed: { borderColor: colors.status.redBg, backgroundColor: colors.status.redBg },
  logDot: { width: 6, height: 6, borderRadius: 3, marginTop: 7 },
  logDotOk: { backgroundColor: colors.status.greenDot },
  logDotFailed: { backgroundColor: colors.red },
  logRowText: { flex: 1, gap: 2 },
  logRowTitle: { fontFamily: font.family.medium, fontSize: 13, lineHeight: 18, color: colors.ink },
  logRowTitleMuted: { color: colors.muted },
  tabs: { flexDirection: "row", gap: space.lg, marginTop: space.xs, borderBottomWidth: 1, borderBottomColor: colors.line },
  tab: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 44, borderBottomWidth: 2, borderBottomColor: "transparent" },
  tabOn: { borderBottomColor: colors.ink },
  tabText: { fontFamily: font.family.semi, fontSize: 15, color: colors.muted },
  tabTextOn: { color: colors.ink },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.4 },
});
