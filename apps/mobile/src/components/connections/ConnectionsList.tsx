import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useIsFocused } from "expo-router";
import type { BottomSheetModal } from "@gorhom/bottom-sheet";
import { Icon } from "../Icon";
import { KeyboardAvoider } from "../KeyboardAvoider";
import { ZaviBorder, hintText } from "../ZaviTextField";
import { SkeletonBlock } from "../Skeleton";
import { useToast } from "../Toast";
import { connectionColors, StatusBadge } from "./StatusBadge";
import { ConnectionSheet } from "./ConnectionSheet";
import { ConnectorTile } from "./ConnectorLogo";
import { Message, SecondaryButton, SectionLabel, settingsStyles } from "../settings/SettingsUI";
import { useConnections, useRefreshConnections, whatsappHandsetsLabel } from "../../features/connectors/useConnections";
import {
  SUGGESTED_CONNECTORS,
  canManageConnectors,
  connectorLabel,
  connectorUses,
} from "../../features/connectors/catalog";
import {
  blockers,
  buildConnections,
  rowSubtitle,
  sectionConnections,
  type Connection,
} from "../../features/connectors/health";
import { DEFAULT_FOR_YOU_SLUGS, FOR_YOU_CAP, purposeFor } from "../../features/connectors/webCatalog";
import { isZaviManagedGithubLogin } from "../../features/connectors/connectPlan";
import { MORE_APPS_PAGE, REQUESTED_NOTE, useComposioToolkits } from "../../features/connectors/composioApps";
import { useWorkspace } from "../../features/workspaces/WorkspaceProvider";
import { font, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

const INITIAL_ROWS = 12;
const ROWS_PER_STEP = 16;

export function ConnectionsList() {
  const styles = useStyles(makeStyles);
  const { colors, textSelectionColor, keyboardAppearance } = useTheme();
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();
  const q = useConnections();
  const refresh = useRefreshConnections();
  const { tenants, activeTenantId } = useWorkspace();
  const canManage = canManageConnectors(tenants.find((t) => t.tenant_id === activeTenantId)?.role);
  const { show, toast } = useToast({ bottom: insets.bottom + 24 }, { fit: "content" });
  const sheet = useRef<BottomSheetModal>(null);
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  const [autoStart, setAutoStart] = useState(false);
  const apps = useComposioToolkits();
  const [query, setQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => Date.now(), [q.data]);
  const toolkits = apps.data?.toolkits;
  const list = useMemo(() => {
    const bySlug = new Map((toolkits ?? []).map((t) => [`composio.${t.slug}`, t]));
    const built = buildConnections({
      rows: q.data?.rows ?? [],
      suggested: SUGGESTED_CONNECTORS,
      labelFor: (slug) => bySlug.get(slug)?.name ?? connectorLabel(slug),
      usedByFor: connectorUses,
      slackMissing: q.data?.slackMissing,
      lastSync: q.data?.lastSync,
      now,
    });
    const handsets = whatsappHandsetsLabel(q.data?.whatsappHandsets ?? []);
    const github = (q.data?.rows ?? []).find((r) => r.slug === "github");
    const githubManaged = !!github && isZaviManagedGithubLogin(github.account_login);
    return built.map((c) =>
      c.slug === "github" && githubManaged
        ? { ...c, managed: true }
        : bySlug.has(c.slug)
        ? { ...c, logoUrl: bySlug.get(c.slug)!.logo }
        : c.slug === "whatsapp" && handsets
          ? { ...c, detail: handsets }
          : c,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data, toolkits]);

  const moreApps = useMemo<Connection[]>(() => {
    const connected = new Set(list.filter((c) => c.health !== "off").map((c) => c.slug));
    const requested = new Set(apps.data?.requested ?? []);
    return (toolkits ?? [])
      .filter((t) => !connected.has(`composio.${t.slug}`))
      .map((t) => {
        const comingSoon = t.connectable === false;
        const isRequested = requested.has(t.slug);
        return {
          slug: `composio.${t.slug}`,
          label: t.name,
          health: "off" as const,
          purpose: comingSoon && isRequested ? REQUESTED_NOTE : purposeFor(t.slug, t.name),
          category: "More apps",
          usedBy: [],
          feedsGoal: false,
          logoUrl: t.logo,
          comingSoon,
          requested: isRequested,
        };
      });
  }, [toolkits, apps.data?.requested, list]);

  const searchText = useDeferredValue(query);
  const needle = searchText.trim().toLowerCase();
  const forYouOrder = q.data?.recommended.length ? q.data.recommended : DEFAULT_FOR_YOU_SLUGS;
  const allGroups = useMemo(() => sectionConnections(list, forYouOrder), [list, forYouOrder]);
  const found = useMemo(() => {
    if (!needle) return null;
    const matches = (c: Connection) => c.label.toLowerCase().includes(needle) || c.slug.toLowerCase().includes(needle);
    return { groups: sectionConnections(list.filter(matches), forYouOrder), more: moreApps.filter(matches) };
  }, [needle, list, moreApps, forYouOrder]);
  const noResults =
    !!found &&
    !apps.isLoading &&
    found.more.length === 0 &&
    found.groups.attention.length === 0 &&
    found.groups.connected.length === 0 &&
    found.groups.forYou.length === 0 &&
    found.groups.categories.length === 0;

  const blocked = blockers(list);
  const open = list.find((c) => c.slug === openSlug) ?? moreApps.find((c) => c.slug === openSlug) ?? null;

  const lastHealth = useRef<Record<string, Connection["health"]>>({});
  useEffect(() => {
    if (!q.data) return;
    for (const c of list) {
      const prev = lastHealth.current[c.slug];
      if (prev && prev !== c.health && c.health === "connected" && isFocused) show(`${c.label} connected`);
      lastHealth.current[c.slug] = c.health;
    }
  }, [list, q.data, isFocused, show]);

  const openSheet = useCallback((c: Connection) => {
    Keyboard.dismiss();
    setAutoStart(false);
    setOpenSlug(c.slug);
    sheet.current?.present();
  }, []);

  const connectSheet = useCallback((c: Connection) => {
    Keyboard.dismiss();
    setAutoStart(true);
    setOpenSlug(c.slug);
    sheet.current?.present();
  }, []);

  return (
    <>
      <KeyboardAvoider style={styles.flex}>
      <ScrollView
        style={styles.flex}
        contentContainerStyle={[settingsStyles.content, { paddingBottom: insets.bottom + 20 }]}
        keyboardShouldPersistTaps="handled"
      >
        {q.isLoading ? (
          <ConnectionsSkeleton />
        ) : q.isError && !q.data ? (
          <View style={styles.errorBox}>
            <Message tone="error">
              Couldn&apos;t load your connections. They are still connected: this is a display problem.
            </Message>
            <SecondaryButton label="Retry" onPress={() => void q.refetch()} />
          </View>
        ) : (
          <>
            <Summary list={list} />

            {blocked.length > 0 ? (
              <View style={styles.banner} accessibilityRole="alert">
                <View style={styles.bannerHead}>
                  <Icon name="alertCircle" size={16} color={colors.status.redText} strokeWidth={2} />
                  <Text style={styles.bannerTitle}>Zavi is blocked</Text>
                </View>
                <Text style={styles.bannerBody}>
                  {`Zavi can't read ${blocked[0].label}${blocked.length > 1 ? ` and ${blocked.length - 1} more` : ""}. Work that needs it waits until it is fixed.`}
                </Text>
                {canManage ? (
                  <Pressable
                    style={({ pressed }) => [styles.bannerButton, pressed && styles.pressed]}
                    onPress={() => openSheet(blocked[0])}
                    accessibilityRole="button"
                  >
                    <Text style={styles.bannerButtonText}>{`Reconnect ${blocked[0].label}`}</Text>
                  </Pressable>
                ) : (
                  <Text style={styles.bannerAsk}>Ask an owner or admin to reconnect it.</Text>
                )}
              </View>
            ) : null}

            {canManage ? null : (
              <Text style={styles.memberNote}>
                You can see every connection. Only owners and admins can connect, reconnect or disconnect.
              </Text>
            )}

            <ZaviBorder selected={searchFocused} radius={10} style={styles.search}>
              <View style={styles.searchBox}>
                <Icon name="search" size={18} color={colors.muted} strokeWidth={2} />
                <TextInput
                  keyboardAppearance={keyboardAppearance}
                  style={styles.searchInput}
                  value={query}
                  onChangeText={setQuery}
                  onFocus={() => setSearchFocused(true)}
                  onBlur={() => setSearchFocused(false)}
                  placeholder={hintText("Search integrations")}
                  placeholderTextColor={colors.muted}
                  cursorColor={colors.ink}
                  selectionColor={textSelectionColor}
                  selectionHandleColor={colors.ink}
                  autoCapitalize="words"
                  autoCorrect={false}
                  returnKeyType="search"
                  accessibilityLabel="Search integrations"
                />
                {query ? (
                  <Pressable
                    style={({ pressed }) => [styles.searchClear, pressed && styles.searchClearPressed]}
                    onPress={() => setQuery("")}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel="Clear search"
                  >
                    <Icon name="close" size={12} color={colors.ink} strokeWidth={2.2} />
                  </Pressable>
                ) : null}
              </View>
            </ZaviBorder>

            {noResults ? (
              <View style={[styles.empty, styles.noResults]}>
                <Icon name="search" size={28} color={colors.muted} strokeWidth={1.75} />
                <Text style={styles.emptyTitle}>No integrations found</Text>
                <Text style={styles.emptyBody}>{`Nothing matches "${searchText.trim()}". Try a different name.`}</Text>
              </View>
            ) : null}

            {}
            <View style={found ? styles.hidden : undefined}>
              <Sections
                groups={allGroups}
                more={moreApps}
                moreLoading={apps.isLoading}
                searching={false}
                resetKey=""
                now={now}
                onOpen={openSheet}
                onConnect={canManage ? connectSheet : undefined}
              />
            </View>
            {found ? (
              <Sections
                groups={found.groups}
                more={found.more}
                moreLoading={apps.isLoading}
                searching
                resetKey={needle}
                now={now}
                onOpen={openSheet}
                onConnect={canManage ? connectSheet : undefined}
              />
            ) : null}
          </>
        )}
      </ScrollView>
      </KeyboardAvoider>

      <ConnectionSheet
        ref={sheet}
        connection={open}
        row={q.data?.rows.find((r) => r.slug === openSlug)}
        slackWorkspaces={q.data?.slackWorkspaces}
        whatsappHandsets={q.data?.whatsappHandsets}
        canManage={canManage}
        autoStart={autoStart}
        onRefresh={() => void refresh()}
        onDisconnected={(label) => {
          sheet.current?.dismiss();
          show(`${label} disconnected`);
          void refresh();
        }}
      />
      {toast}
    </>
  );
}

const Sections = memo(function Sections({
  groups,
  more,
  moreLoading,
  searching,
  resetKey,
  now,
  onOpen,
  onConnect,
}: {
  groups: ReturnType<typeof sectionConnections>;
  more: Connection[];
  moreLoading: boolean;
  searching: boolean;
  resetKey: string;
  now: number;
  onOpen: (c: Connection) => void;
  onConnect?: (c: Connection) => void;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const [moreShown, setMoreShown] = useState(MORE_APPS_PAGE);
  useEffect(() => setMoreShown(MORE_APPS_PAGE), [resetKey]);
  const [paint, setPaint] = useState({ key: resetKey, rows: INITIAL_ROWS });
  const rowsAllowed = paint.key === resetKey ? paint.rows : INITIAL_ROWS;

  let room = rowsAllowed;
  const take = <T,>(items: T[]) => {
    const part = items.slice(0, room);
    room -= part.length;
    return part;
  };
  const moreWindow = more.slice(0, moreShown);
  const totalRows =
    groups.attention.length +
    groups.connected.length +
    groups.forYou.length +
    groups.categories.reduce((n, cat) => n + cat.items.length, 0) +
    moreWindow.length;
  const shown = {
    attention: take(groups.attention),
    connected: take(groups.connected),
    forYou: take(groups.forYou),
    categories: groups.categories
      .map((cat) => ({ title: cat.title, items: take(cat.items) }))
      .filter((cat) => cat.items.length > 0),
    more: take(moreWindow),
  };
  const allShown = rowsAllowed >= totalRows;
  useEffect(() => {
    if (allShown) return;
    const id = setTimeout(() => setPaint({ key: resetKey, rows: rowsAllowed + ROWS_PER_STEP }), 16);
    return () => clearTimeout(id);
  }, [allShown, resetKey, rowsAllowed]);

  function rows(items: Connection[]) {
    return (
      <View style={styles.group}>
        {items.map((c) => (
          <ConnectionRow key={c.slug} c={c} now={now} onOpen={onOpen} onConnect={onConnect} />
        ))}
      </View>
    );
  }

  return (
    <>
      {groups.attention.length > 0 ? (
        <>
          <SectionLabel first>{`Needs reconnect · ${groups.attention.length}`}</SectionLabel>
          {rows(shown.attention)}
        </>
      ) : null}

      {groups.connected.length === 0 && searching ? null : (
        <>
          <SectionLabel first={groups.attention.length === 0}>
            {groups.connected.length ? `Connected · ${groups.connected.length}` : "Connected"}
          </SectionLabel>
          {groups.connected.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>Nothing connected yet</Text>
              <Text style={styles.emptyBody}>
                Connect your ads, analytics and database so Zavi works from your real numbers.
              </Text>
            </View>
          ) : (
            rows(shown.connected)
          )}
        </>
      )}

      {shown.forYou.length > 0 ? (
        <>
          <SectionLabel>For You</SectionLabel>
          {rows(shown.forYou)}
        </>
      ) : null}

      {shown.categories.map((cat) => (
        <View key={cat.title}>
          <SectionLabel>{cat.title}</SectionLabel>
          {rows(cat.items)}
        </View>
      ))}

      {shown.more.length > 0 ? (
        <>
          <SectionLabel>More apps</SectionLabel>
          {rows(shown.more)}
          {allShown && more.length > moreShown ? (
            <Pressable
              style={({ pressed }) => [styles.loadMore, pressed && styles.pressed]}
              onPress={() => setMoreShown((n) => n + MORE_APPS_PAGE)}
              accessibilityRole="button"
            >
              <Text style={styles.loadMoreText}>Load more</Text>
            </Pressable>
          ) : null}
        </>
      ) : moreLoading ? (
        <>
          <SectionLabel>More apps</SectionLabel>
          <ActivityIndicator color={colors.muted} />
        </>
      ) : null}
    </>
  );
});

export const ConnectionRow = memo(function ConnectionRow({
  c,
  now,
  onOpen,
  onConnect,
}: {
  c: Connection;
  now: number;
  onOpen: (c: Connection) => void;
  onConnect?: (c: Connection) => void;
}) {
  const styles = useStyles(makeStyles);
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={() => onOpen(c)}
      accessibilityRole="button"
      accessibilityLabel={`${c.label}: ${c.health === "off" ? "not connected" : c.health === "stale" ? "not syncing" : c.health}`}
    >
      <ConnectorTile slug={c.slug} label={c.label} logoUrl={c.logoUrl} />
      <View style={styles.rowText}>
        <View style={styles.rowTop}>
          <Text style={styles.rowName} numberOfLines={1}>
            {c.label}
          </Text>
          {onConnect && c.health === "off" && !c.comingSoon && !c.managed ? (
            <Pressable
              style={({ pressed }) => [styles.connectButton, pressed && styles.pressed]}
              onPress={() => onConnect(c)}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={`Connect ${c.label}`}
            >
              <Text style={styles.connectButtonText}>Connect</Text>
            </Pressable>
          ) : (
            <StatusBadge c={c} />
          )}
        </View>
        {c.health === "off" ? null : (
          <Text style={styles.rowSub} numberOfLines={1}>
            {rowSubtitle(c, now)}
          </Text>
        )}
      </View>
    </Pressable>
  );
});

function ConnectionsSkeleton() {
  const styles = useStyles(makeStyles);
  const group = (count: number) => (
    <View style={styles.group}>
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={styles.row}>
          <SkeletonBlock width={40} height={40} radius={12} />
          <View style={styles.rowText}>
            <View style={styles.rowTop}>
              <SkeletonBlock width="45%" height={15} />
              <SkeletonBlock width={72} height={22} radius={999} />
            </View>
            <SkeletonBlock width="65%" height={13} style={styles.rowSub} />
          </View>
        </View>
      ))}
    </View>
  );
  return (
    <View accessible accessibilityLabel="Loading connections" accessibilityState={{ busy: true }}>
      <View style={styles.summary}>
        <View style={styles.summaryHead}>
          <SkeletonBlock width={100} height={15} />
          <SkeletonBlock width={90} height={14} />
        </View>
        <SkeletonBlock width="80%" height={14} style={styles.skeletonBody} />
        <SkeletonBlock height={8} radius={999} style={styles.skeletonBar} />
        <View style={styles.legend}>
          <SkeletonBlock width={70} height={13} />
          <SkeletonBlock width={90} height={13} />
        </View>
      </View>
      <View style={styles.search}>
        <SkeletonBlock width={18} height={18} radius={9} />
        <SkeletonBlock width={140} height={15} />
      </View>
      <View style={styles.skeletonLabel}>
        <SkeletonBlock width={90} height={11} radius={4} />
      </View>
      {group(3)}
      <View style={[styles.skeletonLabel, styles.skeletonLabelAfterGroup]}>
        <SkeletonBlock width={60} height={11} radius={4} />
      </View>
      {group(FOR_YOU_CAP)}
    </View>
  );
}

function Summary({ list }: { list: readonly Connection[] }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const n = (...h: Connection["health"][]) => list.filter((c) => h.includes(c.health)).length;
  const CONNECTION_COLORS = connectionColors(colors);
  const parts: [number, string, string][] = [
    [n("connected"), CONNECTION_COLORS.healthy, "healthy"],
    [n("expiring"), CONNECTION_COLORS.amber, "expiring"],
    [n("reconnect"), CONNECTION_COLORS.broken, "broken"],
    [n("off"), CONNECTION_COLORS.off, "not connected"],
  ];
  const stale = n("stale");
  if (stale > 0) parts.splice(1, 0, [stale, CONNECTION_COLORS.amber, "not syncing"]);
  const connected = list.length - n("off");
  return (
    <View style={styles.summary}>
      <View style={styles.summaryHead}>
        <Text style={styles.summaryTitle}>Connections</Text>
        <Text style={styles.summaryCount}>{`${connected} of ${list.length} connected`}</Text>
      </View>
      <Text style={styles.summaryBody}>The tools Zavi reads from and writes to.</Text>
      <View style={styles.bar} accessible accessibilityLabel={parts.map(([c, , l]) => `${c} ${l}`).join(", ")}>
        {parts
          .filter(([c]) => c > 0)
          .map(([c, color, label]) => (
            <View key={label} style={{ flex: c, backgroundColor: color }} />
          ))}
      </View>
      <View style={styles.legend}>
        {parts
          .filter(([c]) => c > 0)
          .map(([c, color, label]) => (
            <View key={label} style={styles.legendItem}>
              <View style={[styles.legendDot, { backgroundColor: color }]} />
              <Text style={styles.legendText}>{`${c} ${label}`}</Text>
            </View>
          ))}
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  skeletonBody: { marginTop: 7 },
  skeletonBar: { marginTop: 15 },
  skeletonLabel: {
    justifyContent: "center",
    minHeight: 22,
    marginTop: space.md,
    marginBottom: space.md,
    paddingLeft: space.xs,
  },
  skeletonLabelAfterGroup: { marginTop: 28 },
  errorBox: { gap: space.md, marginTop: space.md },
  summary: { borderWidth: 1, borderColor: colors.wire.line, borderRadius: 16, backgroundColor: colors.panel, padding: 16 },
  summaryHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", gap: 8 },
  summaryTitle: { fontFamily: font.family.semi, fontSize: 15, color: colors.wire.ink },
  summaryCount: { fontFamily: font.family.regular, fontSize: 14, color: colors.wire.sub, fontVariant: ["tabular-nums"] },
  summaryBody: { marginTop: 4, fontFamily: font.family.regular, fontSize: 14, lineHeight: 20, color: colors.wire.sub },
  bar: { flexDirection: "row", height: 8, gap: 3, marginTop: 12, borderRadius: 999, overflow: "hidden" },
  legend: { flexDirection: "row", flexWrap: "wrap", columnGap: 12, rowGap: 4, marginTop: 10 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { fontFamily: font.family.regular, fontSize: 13, color: colors.wire.sub },
  banner: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: colors.status.redLine,
    borderRadius: 16,
    backgroundColor: colors.status.redBg,
    padding: 16,
  },
  bannerHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  bannerTitle: { fontFamily: font.family.semi, fontSize: 15, color: colors.status.redText },
  bannerBody: { marginTop: 4, fontFamily: font.family.regular, fontSize: 14, lineHeight: 20, color: colors.wire.text },
  bannerButton: {
    alignSelf: "flex-start",
    height: 40,
    justifyContent: "center",
    marginTop: 12,
    paddingHorizontal: 16,
    borderRadius: 999,
    backgroundColor: colors.wire.ink,
  },
  bannerButtonText: { fontFamily: font.family.semi, fontSize: 14, color: colors.onInk },
  bannerAsk: { marginTop: 8, fontFamily: font.family.semi, fontSize: 12, color: colors.muted },
  pressed: { opacity: 0.8 },
  memberNote: { marginTop: 12, fontFamily: font.family.regular, fontSize: 13, lineHeight: 19, color: colors.muted },
  group: {
    borderWidth: 1,
    borderColor: colors.wire.line,
    borderRadius: 16,
    backgroundColor: colors.panel,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 66,
    padding: space.md,
    marginBottom: -1,
    borderBottomWidth: 1,
    borderBottomColor: colors.wire.tint,
    backgroundColor: colors.panel,
  },
  rowPressed: { backgroundColor: colors.wire.tint },
  rowText: { flex: 1, minWidth: 0 },
  rowTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  rowName: { flexShrink: 1, fontFamily: font.family.medium, fontSize: 15, color: colors.wire.text },
  connectButton: {
    height: 32,
    justifyContent: "center",
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 999,
    backgroundColor: colors.panel,
    flexShrink: 0,
  },
  connectButtonText: {
    fontFamily: font.family.semi,
    fontSize: 12,
    lineHeight: 18,
    includeFontPadding: false,
    color: colors.ink,
  },
  rowSub: { marginTop: 4, fontFamily: font.family.regular, fontSize: 13, color: colors.wire.sub },
  empty: {
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.wire.line,
    borderRadius: 16,
    paddingVertical: 20,
    paddingHorizontal: 16,
    gap: 6,
    alignItems: "center",
  },
  noResults: { marginTop: 16, paddingVertical: 28, gap: 8 },
  hidden: { display: "none" },
  flex: { flex: 1 },
  emptyTitle: { fontFamily: font.family.semi, fontSize: 15, color: colors.wire.ink, textAlign: "center" },
  emptyBody: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 19, color: colors.wire.sub, textAlign: "center" },
  search: { marginTop: 12 },
  searchBox: { height: 44, flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: 12 },
  searchInput: {
    flex: 1,
    height: "100%",
    paddingVertical: 0,
    fontFamily: font.family.medium,
    fontSize: 15,
    includeFontPadding: false,
    textAlignVertical: "center",
    color: colors.ink,
  },
  searchClear: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.soft,
    alignItems: "center",
    justifyContent: "center",
  },
  searchClearPressed: { opacity: 0.7 },
  loadMore: {
    alignSelf: "center",
    minHeight: 40,
    justifyContent: "center",
    marginTop: 12,
    paddingHorizontal: 18,
    borderWidth: 1,
    borderColor: colors.wire.line,
    borderRadius: 999,
  },
  loadMoreText: { fontFamily: font.family.semi, fontSize: 14, color: colors.wire.text },
});
