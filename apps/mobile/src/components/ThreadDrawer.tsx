import { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  BackHandler,
  Dimensions,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSteadyTopInset } from "./KeyboardAvoider";
import { WorkspaceLogo } from "./WorkspaceLogo";
import { Icon, type IconName } from "./Icon";
import { useAuth } from "../auth/AuthProvider";
import { useChatThreads, type ChatThreadRow } from "../features/agents/hooks";
import { useWorkspace } from "../features/workspaces/WorkspaceProvider";
import { font, radius, space, type Colors } from "../theme/tokens";
import { useStyles, useTheme } from "../theme/theme";
import type { AgentThreadRow } from "../features/agents/types";
import { useReduceMotion } from "../lib/motion";
import { usePinnedThreads } from "../features/agents/threadActions";
import { useChannelsReadyCount } from "../features/channels/hooks";
import { useBuildSessions } from "../features/build/hooks";
import { mergeRecent, type BuildSessionState } from "../features/build/logic";
import { useBrokenConnectorCount } from "../features/connectors/useConnections";
import { ADD_WORKSPACE_ENABLED } from "../lib/flags";
import { CHANNELS_ENABLED } from "../lib/flags";

const WIDTH = Math.min(320, Dimensions.get("window").width * 0.86);
const DURATION = 190;

type DrawerItem =
  | { kind: "heading"; key: string; label: string }
  | { kind: "thread"; key: string; row: ChatThreadRow; pinned?: boolean }
  | { kind: "build"; key: string; id: string; title: string; state: BuildSessionState };

type Props = {
  visible: boolean;
  onClose: () => void;
  currentThreadId?: string;
  onSelectThread: (row: ChatThreadRow) => void;
  onSelectBuild?: (id: string) => void;
  onNewChat: () => void;
  onOpenSettings: () => void;
  onOpenSearch: () => void;
  onAddWorkspace: () => void;
  onOpenArtifacts: () => void;
  onOpenChannels?: () => void;
  onOpenGrowth?: () => void;
  onOpenAnalytics?: () => void;
  onOpenMessaging?: () => void;
  onOpenBuild?: () => void;
  onOpenAgentBuilder?: () => void;
  onOpenConnectors?: () => void;
  onOpenApprovals?: () => void;
  pendingApprovals?: number;
};

function statusDotColor(colors: Colors, status: AgentThreadRow["presentation_status"]): string | null {
  if (status === "running") return colors.status.running;
  if (status === "failed") return colors.status.redDot;
  if (status === "answered") return colors.status.done;
  return null;
}

export function ThreadDrawer({
  visible,
  onClose,
  currentThreadId,
  onSelectThread,
  onSelectBuild,
  onNewChat,
  onOpenSettings,
  onOpenSearch,
  onAddWorkspace,
  onOpenArtifacts,
  onOpenChannels,
  onOpenGrowth,
  onOpenAnalytics,
  onOpenMessaging,
  onOpenBuild,
  onOpenAgentBuilder,
  onOpenConnectors,
  onOpenApprovals,
  pendingApprovals = 0,
}: Props) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const steadyTop = useSteadyTopInset();
  const { data: threads } = useChatThreads();
  const { data: pinnedIds } = usePinnedThreads();
  const builds = useBuildSessions();
  const { session } = useAuth();
  const { tenants, activeTenantId, switchTo } = useWorkspace();
  const active = tenants.find((t) => t.tenant_id === activeTenantId);

  const email = session?.user?.email ?? "";
  const fullName =
    (typeof session?.user?.user_metadata?.full_name === "string"
      ? session.user.user_metadata.full_name.trim()
      : "") || (email ? email.split("@")[0] : "Signed in");

  const [historyOpen, setHistoryOpen] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [brandBottom, setBrandBottom] = useState(0);
  const [mounted, setMounted] = useState(visible);
  const [built, setBuilt] = useState(visible);
  const reduceMotion = useReduceMotion();
  const slide = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (menuOpen) setMenuOpen(false);
      else onClose();
      return true;
    });
    return () => sub.remove();
  }, [visible, menuOpen, onClose]);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      setBuilt(true);
    }
    if (reduceMotion) {
      slide.setValue(visible ? 1 : 0);
      if (!visible) setMounted(false);
      return;
    }
    const anim = Animated.timing(slide, {
      toValue: visible ? 1 : 0,
      duration: DURATION,
      useNativeDriver: true,
    });
    anim.start(({ finished }) => {
      if (finished && !visible) setMounted(false);
    });
    return () => anim.stop();
  }, [visible, reduceMotion, slide]);

  useEffect(() => {
    if (visible) {
      setMenuOpen(false);
      if (onSelectBuild) void builds.refetch();
    }
  }, [visible]);

  const showBuilds = !!onSelectBuild;
  const list = useMemo((): DrawerItem[] => {
    const rows = threads ?? [];
    const pins = pinnedIds ?? [];
    const byId = new Map(rows.map((t) => [t.id, t]));
    const pinned = pins.map((id) => byId.get(id)).filter((t): t is ChatThreadRow => !!t);
    const recent = mergeRecent(
      rows.filter((t) => !pins.includes(t.id)),
      showBuilds ? builds.data : null,
    );
    const items: DrawerItem[] = [];
    if (pinned.length > 0) {
      items.push({ kind: "heading", key: "h-pinned", label: "Pinned" });
      pinned.forEach((row) => items.push({ kind: "thread", key: `p-${row.id}`, row, pinned: true }));
    }
    if (recent.length > 0) {
      if (pinned.length > 0) items.push({ kind: "heading", key: "h-recent", label: "Recent" });
      recent.forEach((e) =>
        items.push(e.kind === "thread" ? { kind: "thread", key: e.row.id, row: e.row } : { ...e, key: `b-${e.id}` }),
      );
    }
    return items;
  }, [threads, pinnedIds, builds.data, showBuilds]);

  if (!built) return null;

  return (
    <View style={[styles.root, { top: steadyTop }, !mounted && styles.hidden]}>
      <Animated.View style={[styles.scrimLayer, { opacity: slide }]}>
        <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Close menu" />
      </Animated.View>

      <Animated.View
        style={[
          styles.panel,
          { transform: [{ translateX: slide.interpolate({ inputRange: [0, 1], outputRange: [-WIDTH, 0] }) }] },
        ]}
      >
        <View
          style={[
            styles.panelSafe,
            { paddingTop: space.md, paddingLeft: space.md + insets.left },
          ]}
        >
          <View style={styles.flex}>
            {}
            <View
              style={styles.header}
              onLayout={(e) => setBrandBottom(e.nativeEvent.layout.y + e.nativeEvent.layout.height)}
            >
              <Pressable
                style={styles.workspace}
                onPress={() => setMenuOpen((v) => !v)}
                accessibilityRole="button"
                accessibilityState={{ expanded: menuOpen }}
                accessibilityLabel={
                  active ? `Workspace: ${active.display_name}. Switch workspace` : "Switch workspace"
                }
              >
                <Initial name={active?.display_name ?? "Workspace"} website={active?.website} />
                <Text style={styles.workspaceName} numberOfLines={1}>
                  {active?.display_name ?? "Workspace"}
                </Text>
                <View style={menuOpen ? styles.caretUp : undefined}>
                  <Icon name="chevronDown" size={20} color={colors.wire.ink} strokeWidth={2} />
                </View>
              </Pressable>
              <Pressable
                style={styles.closeBtn}
                onPress={onOpenSearch}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel="Search chats"
              >
                <Icon name="search" size={20} color={colors.wire.mute} strokeWidth={2} />
              </Pressable>
            </View>

            <FlatList
              data={historyOpen ? list : []}
              keyExtractor={(item) => item.key}
              style={styles.scroll}
              contentContainerStyle={styles.list}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              ListEmptyComponent={historyOpen ? <Text style={styles.empty}>No chats yet.</Text> : null}
              ListHeaderComponent={
                <>
                  <View style={styles.nav}>
                    <NavRow icon="home" label="Home" selected onPress={onClose} />
                    {onOpenApprovals ? (
                      <NavRow
                        icon="shieldCheck"
                        label="Approvals"
                        badge={pendingApprovals > 0 ? { text: `${pendingApprovals} waiting`, tone: "amber" } : undefined}
                        onPress={onOpenApprovals}
                      />
                    ) : null}
                    {}
                    {CHANNELS_ENABLED && onOpenChannels ? <ChannelsNavRow onPress={onOpenChannels} /> : null}
                    {onOpenAnalytics ? <NavRow icon="chartColumn" label="Analytics" onPress={onOpenAnalytics} /> : null}
                    {onOpenMessaging ? <NavRow icon="messages" label="Messaging" onPress={onOpenMessaging} /> : null}
                    {onOpenBuild ? <NavRow icon="appWindow" label="Build" onPress={onOpenBuild} /> : null}
                    {onOpenGrowth ? <NavRow icon="target" label="Your CGO" onPress={onOpenGrowth} /> : null}
                    {onOpenAgentBuilder ? <NavRow icon="bot" label="Agent Builder" onPress={onOpenAgentBuilder} /> : null}
                    <NavRow icon="package" label="Artifacts" onPress={onOpenArtifacts} />
                    {onOpenConnectors ? <ConnectorsNavRow onPress={onOpenConnectors} /> : null}
                    <NavRow icon="gear" label="Settings" onPress={onOpenSettings} />
                  </View>
                  <View style={styles.history}>
                    <View style={styles.historyHead}>
                      <Pressable
                        style={styles.historyToggle}
                        onPress={() => setHistoryOpen((v) => !v)}
                        accessibilityRole="button"
                        accessibilityState={{ expanded: historyOpen }}
                        accessibilityLabel="Recent"
                      >
                        <Text style={styles.historyLabel}>RECENT</Text>
                        <View style={historyOpen ? undefined : styles.caretRight}>
                          <Icon name="chevronDown" size={16} color={colors.wire.mute} strokeWidth={2} />
                        </View>
                      </Pressable>
                      <Pressable
                        style={styles.historyAdd}
                        onPress={onNewChat}
                        accessibilityRole="button"
                        accessibilityLabel="Start a new chat"
                      >
                        <Icon name="add" size={16} color={colors.ink} strokeWidth={2} />
                      </Pressable>
                    </View>
                  </View>
                </>
              }
              renderItem={({ item }) =>
                item.kind === "heading" ? (
                  <Text style={styles.section}>{item.label}</Text>
                ) : item.kind === "build" ? (
                  <BuildRow title={item.title} state={item.state} onPress={() => onSelectBuild?.(item.id)} />
                ) : (
                  <ThreadRow
                    row={item.row}
                    current={item.row.id === currentThreadId}
                    pinned={item.pinned}
                    onPress={() => onSelectThread(item.row)}
                  />
                )
              }
            />

            {}
            <View
              style={[
                styles.bottom,
                {
                  marginLeft: -(space.md + insets.left),
                  paddingLeft: space.sm + insets.left,
                  paddingBottom: Math.max(insets.bottom, space.md),
                },
              ]}
            >
              <Pressable
                style={styles.account}
                onPress={onOpenSettings}
                accessibilityRole="button"
                accessibilityLabel={email ? `Account and settings, signed in as ${email}` : "Account and settings"}
              >
                <Initial name={fullName} />
                <View style={styles.accountText}>
                  <Text style={styles.accountName} numberOfLines={1}>
                    {fullName}
                  </Text>
                  {email ? (
                    <Text style={styles.accountEmail} numberOfLines={1}>
                      {email}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
            </View>
          </View>
        </View>

        {menuOpen ? (
          <>
            {}
            <Pressable
              style={StyleSheet.absoluteFill}
              onPress={() => setMenuOpen(false)}
              accessibilityLabel="Close workspace menu"
            />
            <View
              style={[
                styles.menu,
                {
                  top: space.md + brandBottom + space.xs,
                  left: space.md + insets.left,
                },
              ]}
            >
              <Text style={styles.menuTitle}>WORKSPACES</Text>
              <ScrollView style={styles.menuScroll} keyboardShouldPersistTaps="handled">
                {tenants.map((t) => {
                  const isActive = t.tenant_id === activeTenantId;
                  return (
                    <Pressable
                      key={t.tenant_id}
                      style={styles.menuRow}
                      accessibilityRole="button"
                      accessibilityState={{ selected: isActive }}
                      onPress={() => {
                        setMenuOpen(false);
                        if (!isActive) switchTo(t.tenant_id).catch(() => {});
                      }}
                    >
                      <Initial name={t.display_name} website={t.website} small />
                      <Text style={styles.menuRowText} numberOfLines={1}>
                        {t.display_name}
                      </Text>
                      {isActive ? <Icon name="tick" size={16} color={colors.wire.ink} strokeWidth={2} /> : null}
                    </Pressable>
                  );
                })}
              </ScrollView>
              {ADD_WORKSPACE_ENABLED ? (
                <>
                  {}
                  <View style={styles.menuDivider} />
                  <Pressable
                    style={styles.menuRow}
                    accessibilityRole="button"
                    onPress={() => {
                      setMenuOpen(false);
                      onAddWorkspace();
                    }}
                  >
                    <View style={styles.menuAddIcon}>
                      <Icon name="add" size={14} color={colors.ink} strokeWidth={2} />
                    </View>
                    <Text style={styles.menuRowText} numberOfLines={1}>
                      Add new workspace
                    </Text>
                  </Pressable>
                </>
              ) : null}
            </View>
          </>
        ) : null}
      </Animated.View>
    </View>
  );
}

function ThreadRow({
  row,
  current,
  pinned = false,
  onPress,
}: {
  row: ChatThreadRow;
  current: boolean;
  pinned?: boolean;
  onPress: () => void;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const status = statusDotColor(colors, row.presentation_status);
  const agent = row.topic;
  return (
    <Pressable
      style={[styles.row, current && styles.rowCurrent]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${row.title || "Untitled thread"}${agent ? `, ${agent}` : ""}`}
    >
      {pinned ? <Icon name="pinSmall" size={14} color={colors.wire.faint} strokeWidth={2} /> : null}
      <Text style={[styles.rowTitle, current && styles.rowTitleCurrent]} numberOfLines={1}>
        {row.title || "Untitled thread"}
      </Text>
      {agent ? (
        <Text style={styles.rowAgent} numberOfLines={1}>
          {agent}
        </Text>
      ) : null}
      {status && !current && (row.presentation_status !== "answered" || row.unread) ? <View style={[styles.statusDot, { backgroundColor: status }]} /> : null}
      {row.pending ? <View style={styles.pendingDot} /> : null}
    </Pressable>
  );
}

function BuildRow({ title, state, onPress }: { title: string; state: BuildSessionState; onPress: () => void }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const dot =
    state === "building" || state === "publishing"
      ? colors.status.running
      : state === "failed" || state === "publish_failed"
        ? colors.status.redDot
        : null;
  return (
    <Pressable style={styles.row} onPress={onPress} accessibilityRole="button" accessibilityLabel={`${title}, Build`}>
      <Text style={styles.rowTitle} numberOfLines={1}>
        {title}
      </Text>
      <Text style={styles.rowAgent} numberOfLines={1}>
        Build
      </Text>
      {dot ? <View style={[styles.statusDot, { backgroundColor: dot }]} /> : null}
    </Pressable>
  );
}

function Initial({ name, website, small = false }: { name: string; website?: string | null; small?: boolean }) {
  const styles = useStyles(makeStyles);
  const letter = (
    <View style={[styles.initial, small && styles.initialSmall]}>
      <Text style={[styles.initialText, small && styles.initialTextSmall]}>
        {(name.trim()[0] ?? "?").toUpperCase()}
      </Text>
    </View>
  );
  return website ? <WorkspaceLogo website={website} size={small ? 28 : 36} fallback={letter} /> : letter;
}

function NavRow({
  icon,
  label,
  selected = false,
  badge,
  onPress,
}: {
  icon: IconName;
  label: string;
  selected?: boolean;
  badge?: { text: string; tone: "amber" | "green" | "red" };
  onPress: () => void;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const tint = selected ? colors.wire.ink : colors.wire.body;
  return (
    <Pressable
      style={({ pressed }) => [styles.navRow, (selected || pressed) && styles.navRowSelected]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={badge ? `${label}, ${badge.text}` : label}
    >
      {selected ? <View style={styles.navBar} /> : null}
      <Icon name={icon} size={20} color={tint} strokeWidth={1.9} />
      <Text style={[styles.navText, selected && styles.navTextSelected]}>{label}</Text>
      {badge ? (
        <Text
          style={[
            styles.navBadge,
            badge.tone === "amber"
              ? { backgroundColor: colors.status.amberBg, color: colors.status.amberText }
              : badge.tone === "red"
                ? { backgroundColor: colors.status.redBg, color: colors.status.redText }
                : { backgroundColor: colors.status.greenBg, color: colors.status.greenText },
          ]}
        >
          {badge.text}
        </Text>
      ) : null}
    </Pressable>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  root: { position: "absolute", right: 0, bottom: 0, left: 0, overflow: "hidden" },
  hidden: { display: "none" },
  scrimLayer: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 },
  scrim: { flex: 1, backgroundColor: colors.drawerScrim },
  panel: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    width: WIDTH,
    backgroundColor: colors.drawerBg,
    borderRightWidth: 1,
    borderRightColor: colors.line,
  },
  panelSafe: { flex: 1, paddingHorizontal: space.md },
  flex: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingTop: space.xs,
    paddingBottom: space.sm,
  },
  workspace: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: space.xs,
    borderRadius: radius.md,
  },
  workspaceName: { flexShrink: 1, fontFamily: font.family.bold, fontSize: 17, color: colors.wire.ink, includeFontPadding: false },
  closeBtn: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  caretUp: { transform: [{ rotate: "180deg" }] },
  caretRight: { transform: [{ rotate: "-90deg" }] },
  initial: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.wire.ink,
    alignItems: "center",
    justifyContent: "center",
  },
  initialText: { fontFamily: font.family.semi, fontSize: 15, color: colors.onInk, includeFontPadding: false },
  initialSmall: { width: 28, height: 28, borderRadius: 14 },
  initialTextSmall: { fontSize: 11 },
  nav: { gap: 3 },
  navRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    height: 40,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
  },
  navRowSelected: { backgroundColor: colors.wire.selected },
  navBar: {
    position: "absolute",
    left: -space.md,
    top: 10,
    width: 3,
    height: 20,
    borderRadius: 2,
    backgroundColor: colors.wire.ink,
  },
  navText: { flex: 1, fontFamily: font.family.medium, fontSize: 15.5, color: colors.wire.body, includeFontPadding: false },
  navTextSelected: { fontFamily: font.family.semi, color: colors.wire.ink },
  navBadge: {
    overflow: "hidden",
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    fontFamily: font.family.semi,
    fontSize: 12,
    includeFontPadding: false,
  },
  scroll: { flex: 1, marginLeft: -space.md },
  history: {
    marginTop: space.sm,
    paddingTop: space.sm,
    borderTopWidth: 1,
    borderTopColor: colors.wire.line,
  },
  historyHead: { height: 36, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  historyToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    borderRadius: space.sm,
  },
  historyLabel: {
    fontFamily: font.family.semi,
    fontSize: 13,
    letterSpacing: 1.04,
    color: colors.wire.mute,
    includeFontPadding: false,
  },
  historyAdd: { width: 36, height: 36, borderRadius: space.sm, alignItems: "center", justifyContent: "center" },
  menu: {
    position: "absolute",
    right: space.md,
    padding: 6,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.wire.line,
    borderRadius: 16,
    shadowColor: "#0e0f11",
    shadowOpacity: 0.14,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 12 },
    elevation: 8,
  },
  menuTitle: {
    paddingHorizontal: 10,
    paddingTop: 6,
    paddingBottom: space.xs,
    fontFamily: font.family.semi,
    fontSize: 12,
    letterSpacing: 0.96,
    color: colors.wire.faint,
    includeFontPadding: false,
  },
  menuScroll: { maxHeight: 260 },
  menuDivider: { height: 1, backgroundColor: colors.wire.tint, marginVertical: space.xs },
  menuAddIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.wire.faint,
    alignItems: "center",
    justifyContent: "center",
  },
  menuRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: space.sm,
    borderRadius: space.sm,
  },
  menuRowText: {
    flex: 1,
    minWidth: 0,
    fontFamily: font.family.medium,
    fontSize: 14.5,
    color: colors.wire.ink,
    includeFontPadding: false,
  },
  list: { paddingLeft: space.md, paddingBottom: space.md },
  section: {
    marginTop: space.md,
    marginBottom: 2,
    paddingHorizontal: space.md,
    fontFamily: font.family.semi,
    fontSize: 12.5,
    color: colors.wire.faint,
    includeFontPadding: false,
  },
  empty: { paddingVertical: space.md, paddingHorizontal: space.md, fontSize: font.size.sm, color: colors.wire.mute },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: 9,
    borderRadius: space.sm,
  },
  rowCurrent: { backgroundColor: colors.wire.selected },
  rowTitle: { flex: 1, fontFamily: font.family.regular, fontSize: 15, color: colors.wire.sub, includeFontPadding: false },
  rowTitleCurrent: { fontFamily: font.family.medium, color: colors.wire.text },
  rowAgent: { flexShrink: 0, maxWidth: 96, fontFamily: font.family.regular, fontSize: 12, color: colors.wire.mute, includeFontPadding: false },
  pendingDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.status.amberDot },
  statusDot: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  bottom: {
    marginRight: -space.md,
    paddingTop: space.sm,
    paddingRight: space.sm,
    borderTopWidth: 1,
    borderTopColor: colors.wire.line,
  },
  account: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: space.sm,
    paddingVertical: 6,
    borderRadius: radius.md,
  },
  accountText: { flex: 1, minWidth: 0 },
  accountName: { fontFamily: font.family.semi, fontSize: 15, color: colors.wire.ink, includeFontPadding: false },
  accountEmail: {
    marginTop: 2,
    fontFamily: font.family.regular,
    fontSize: 13,
    color: colors.wire.mute,
    includeFontPadding: false,
  },
});

function ChannelsNavRow({ onPress }: { onPress: () => void }) {
  const readyCount = useChannelsReadyCount();
  return (
    <NavRow
      icon="inbox"
      label="Channels"
      badge={readyCount > 0 ? { text: `${readyCount} ready`, tone: "green" } : undefined}
      onPress={onPress}
    />
  );
}

function ConnectorsNavRow({ onPress }: { onPress: () => void }) {
  const broken = useBrokenConnectorCount();
  return (
    <NavRow
      icon="blocks"
      label="Connectors"
      badge={broken > 0 ? { text: `${broken} broken`, tone: "red" } : undefined}
      onPress={onPress}
    />
  );
}
