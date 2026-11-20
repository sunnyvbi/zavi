import { forwardRef, useCallback, useEffect, useState } from "react";
import { AppState, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import {
  BottomSheetBackdrop,
  BottomSheetHandle,
  BottomSheetModal,
  BottomSheetScrollView,
  type BottomSheetHandleProps,
} from "@gorhom/bottom-sheet";
import { useBackClosesSheet } from "../AppBottomSheet";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { connectInfoFor, type ConnectInfo } from "@zavi/shared";
import { ConfirmDialog } from "../ConfirmDialog";
import { ConnectControl } from "../connect/ConnectControl";
import { ListGroup, Message, Row } from "../settings/SettingsUI";
import { StatusBadge } from "./StatusBadge";
import { Icon } from "../Icon";
import { ConnectorTile } from "./ConnectorLogo";
import { GithubManage } from "./GithubManage";
import { SlackManage } from "./SlackManage";
import { DiscordConnect, TeamsConnect, TelegramConnect, WhatsAppConnect, WhatsAppNumbers } from "./ChatConnect";
import type { SlackWorkspace, WhatsAppHandset } from "../../features/connectors/useConnections";
import { disconnectConnector } from "../../features/connectors/api";
import { REQUESTED_NOTE, useRequestApp } from "../../features/connectors/composioApps";
import { disconnectCopy, disconnectPath } from "../../features/connectors/catalog";
import { planConnect } from "../../features/connectors/connectPlan";
import { agoText, shortDate, type Connection, type ConnectorRow } from "../../features/connectors/health";
import { ApiFetchError } from "../../lib/api";
import { track } from "../../lib/analytics";
import { font, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

function providerOf(slug: string, label: string): string {
  if (slug.startsWith("google_")) return "Google";
  if (slug === "meta_ads") return "Facebook";
  if (slug.startsWith("composio.")) return "Composio";
  return label;
}

function disconnectErrorMessage(e: unknown, label: string): string {
  if (e instanceof ApiFetchError) {
    if (e.code === "forbidden" || e.code === "not_admin") {
      return `Only an owner or admin can disconnect ${label}.`;
    }
    return e.message === `Request failed (${e.status})` ? `HTTP ${e.status}` : e.message;
  }
  return e instanceof Error ? e.message : `Couldn't disconnect ${label}.`;
}

export const ConnectionSheet = forwardRef<
  BottomSheetModal,
  {
    connection: Connection | null;
    row?: ConnectorRow;
    slackWorkspaces?: SlackWorkspace[];
    whatsappHandsets?: WhatsAppHandset[];
    canManage: boolean;
    autoStart?: boolean;
    onRefresh: () => void;
    onDisconnected: (label: string) => void;
  }
>(function ConnectionSheet(
  { connection: c, row, slackWorkspaces = [], whatsappHandsets = [], canManage, autoStart = false, onRefresh, onDisconnected },
  ref,
) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const requestApp = useRequestApp();

  const renderBackdrop = useCallback(
    (p: React.ComponentProps<typeof BottomSheetBackdrop>) => (
      <BottomSheetBackdrop {...p} appearsOnIndex={0} disappearsOnIndex={-1} />
    ),
    [],
  );

  const now = Date.now();
  const connected = !!c && c.health !== "off";
  const composioFallback: ConnectInfo | undefined =
    c && c.slug.startsWith("composio.") ? { connect: "composio", label: c.label, settingsAnchor: null } : undefined;
  const info = c ? (connectInfoFor(c.slug, c.label) ?? composioFallback ?? null) : null;
  const plan = c && info ? planConnect(c.slug, info) : null;
  const path = c && connected ? disconnectPath(c.slug) : null;
  const copy = c ? disconnectCopy(c.slug) : null;
  const canDisconnectThis = connected && !c?.managed && !!path;
  const verb = connected ? "Reconnect" : "Connect";
  const lastSynced = connected ? agoText(c?.lastSyncAt, now) : undefined;
  const slackPanel = !!c && c.slug === "slack" && connected;
  const githubPanel = !!c && c.slug === "github" && connected && !!row;
  const chatSlug = c && (c.slug === "telegram" || c.slug === "discord" || c.slug === "whatsapp") ? c.slug : null;
  const whatsappPanel = chatSlug === "whatsapp" && connected;
  const teams = !!c && c.slug === "teams";
  const [flowOpen, setFlowOpen] = useState(false);
  const chatAutoStart = connected || autoStart;
  const chatFlow =
    chatSlug === "telegram" ? (
      <TelegramConnect
        autoStart={chatAutoStart}
        onConnected={() => {
          setFlowOpen(false);
          onRefresh();
        }}
      />
    ) : chatSlug === "discord" ? (
      <DiscordConnect
        autoStart={chatAutoStart}
        onConnected={() => {
          setFlowOpen(false);
          onRefresh();
        }}
      />
    ) : chatSlug === "whatsapp" ? (
      <WhatsAppConnect
        autoStart={chatAutoStart}
        onConnected={() => {
          setFlowOpen(false);
          onRefresh();
        }}
      />
    ) : null;

  useEffect(() => {
    if (!sheetOpen) return;
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") onRefresh();
    });
    return () => sub.remove();
  }, [onRefresh, sheetOpen]);

  async function disconnect() {
    if (!c || !path) return;
    setConfirming(false);
    setBusy(true);
    setError(null);
    try {
      await disconnectConnector(path);
      track("connector_disconnected", { slug: c.slug });
      onDisconnected(c.label);
    } catch (e) {
      setError(disconnectErrorMessage(e, c.label));
    } finally {
      setBusy(false);
    }
  }

  const onSheetChange = useBackClosesSheet();
  const renderHeader = useCallback(
    (props: BottomSheetHandleProps) => (
      <View>
        <BottomSheetHandle {...props} />
        {c ? (
          <View style={styles.header}>
            <View style={styles.titleRow}>
              <ConnectorTile slug={c.slug} label={c.label} size={32} logoUrl={c.logoUrl} />
              <Text style={styles.title} accessibilityRole="header" numberOfLines={1}>
                {c.label}
              </Text>
              <Pressable
                style={({ pressed }) => [styles.close, (pressed || busy) && styles.dim]}
                onPress={() => {
                  if (!busy && ref && typeof ref !== "function") ref.current?.dismiss();
                }}
                disabled={busy}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel="Close"
              >
                <Icon name="close" size={16} color={colors.ink} strokeWidth={2} />
              </Pressable>
            </View>
            <View style={styles.badgeRow}>
              <StatusBadge c={c} />
            </View>
          </View>
        ) : null}
      </View>
    ),
    [c, busy, ref, styles, colors.muted],
  );
  return (
    <BottomSheetModal
      ref={ref}
      onChange={onSheetChange}
      enableDynamicSizing
      topInset={insets.top}
      maxDynamicContentSize={Math.round(windowHeight * 0.86)}
      enablePanDownToClose
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      backdropComponent={renderBackdrop}
      backgroundStyle={styles.sheetBg}
      handleComponent={renderHeader}
      handleStyle={styles.handle}
      handleIndicatorStyle={styles.handleIndicator}
      enableHandlePanningGesture={!busy}
      onChange={(index) => setSheetOpen(index >= 0)}
      onDismiss={() => {
        setError(null);
        setConfirming(false);
        setFlowOpen(false);
        setSheetOpen(false);
      }}
    >
      {c ? (
        <BottomSheetScrollView
          contentContainerStyle={[styles.content, { paddingBottom: space.xl + insets.bottom }]}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.note}>{c.reason ?? c.purpose}</Text>
          {c.health === "stale" ? (
            <Text style={styles.note}>
              {`Zavi hasn't pulled new numbers from ${c.label} in over a day. Reconnect if it keeps happening.`}
            </Text>
          ) : null}

          {slackPanel ? (
            <SlackManage workspaces={slackWorkspaces} canManage={canManage} onChanged={onRefresh} />
          ) : githubPanel && row ? (
            <GithubManage row={row} canManage={canManage} managed={!!c.managed} onChanged={onRefresh} />
          ) : whatsappPanel ? (
            <WhatsAppNumbers handsets={whatsappHandsets} canManage={canManage} onChanged={onRefresh} />
          ) : connected ? (
            <View style={styles.group}>
              <ListGroup>
                <Row label="Account" detail={c.detail ?? c.account ?? "Connected"} />
                <Row label="Connected" detail={shortDate(c.connectedAt) ?? "Never"} />
                {lastSynced ? <Row label="Last synced" detail={lastSynced} /> : null}
              </ListGroup>
            </View>
          ) : null}

          {error ? (
            <View style={styles.error}>
              <Message tone="error">{error}</Message>
            </View>
          ) : null}

          {canManage && c.comingSoon && !connected ? (
            <View style={styles.actions}>
              <Text style={styles.muted}>
                {c.requested
                  ? REQUESTED_NOTE
                  : `${c.label} can't be connected yet. Tell us you need it and we'll prioritise it.`}
              </Text>
              <Pressable
                style={({ pressed }) => [
                  styles.request,
                  (pressed || requestApp.isPending || c.requested) && styles.dim,
                ]}
                onPress={() => {
                  track("connector_app_requested");
                  requestApp.mutate(c.slug.slice("composio.".length), {
                    onError: () => setError("Couldn't send your request. Try again."),
                  });
                }}
                disabled={requestApp.isPending || c.requested}
                accessibilityRole="button"
                accessibilityState={{
                  disabled: !!c.requested,
                  busy: requestApp.isPending,
                }}
              >
                <Text style={styles.requestText} numberOfLines={1}>
                  {c.requested ? "Requested" : "I need it"}
                </Text>
              </Pressable>
            </View>
          ) : canManage ? (
            <View style={styles.actions}>
              {chatSlug ? (
                connected && chatSlug === "whatsapp" ? null : connected && !flowOpen ? (
                  <Pressable
                    style={({ pressed }) => [styles.reconnect, pressed && styles.dim]}
                    onPress={() => setFlowOpen(true)}
                    accessibilityRole="button"
                  >
                    <Text style={styles.reconnectText} numberOfLines={1}>
                      Reconnect
                    </Text>
                  </Pressable>
                ) : (
                  chatFlow
                )
              ) : teams ? (
                connected ? null : <TeamsConnect onConnected={onRefresh} />
              ) : githubPanel ? null : info ? (
                <ConnectControl
                  slug={c.slug}
                  label={c.label}
                  fallback={composioFallback}
                  mode={connected ? "reconnect" : "connect"}
                  variant={!connected || c.health === "reconnect" ? "primary" : "secondary"}
                  block
                  onAttempted={onRefresh}
                />
              ) : (
                <Text style={styles.muted}>{`Manage ${c.label} from Settings on zaviagent.com.`}</Text>
              )}
              {!githubPanel && plan && (plan.kind === "oauth" || plan.kind === "composio") ? (
                <Text style={styles.small}>
                  {`Opens ${providerOf(c.slug, c.label)} in the browser. Come back when it says you're connected.`}
                </Text>
              ) : null}
              {canDisconnectThis ? (
                path ? (
                  <>
                    <View style={styles.divider} />
                    <Pressable
                      style={({ pressed }) => [styles.disconnect, (pressed || busy) && styles.dim]}
                      onPress={() => setConfirming(true)}
                      disabled={busy}
                      accessibilityRole="button"
                      accessibilityState={{ busy }}
                    >
                      <Text style={styles.disconnectText} numberOfLines={1}>
                        {busy ? "Disconnecting…" : "Disconnect"}
                      </Text>
                    </Pressable>
                  </>
                ) : null
              ) : null}
            </View>
          ) : (
            <Text style={[styles.muted, styles.actions]}>
              {teams && connected
                ? `Only owners and admins can disconnect ${c.label}.`
                : `Only owners and admins can ${verb.toLowerCase()}${canDisconnectThis ? " or disconnect" : ""} ${c.label}.`}
            </Text>
          )}

          <ConfirmDialog
            visible={confirming}
            logo={<ConnectorTile slug={c.slug} label={c.label} logoUrl={c.logoUrl} />}
            title={copy?.title ?? `Disconnect ${c.label}?`}
            message={
              copy?.description ??
              `Zavi stops reading it right away, so ${
                c.usedBy.length ? c.usedBy.join(", ").toLowerCase() : "anything that needs it"
              } stop working. You can connect it again any time.`
            }
            cancelLabel="Keep it"
            confirmLabel="Disconnect"
            destructive
            onCancel={() => setConfirming(false)}
            onConfirm={() => void disconnect()}
          />
        </BottomSheetScrollView>
      ) : null}
    </BottomSheetModal>
  );
});

const makeStyles = (colors: Colors) => StyleSheet.create({
  sheetBg: { backgroundColor: colors.surfaceRaised, borderTopLeftRadius: 22, borderTopRightRadius: 22 },
  handle: { paddingTop: space.sm, paddingBottom: space.xs },
  handleIndicator: { width: 36, height: 5, borderRadius: 3, backgroundColor: colors.wire.border },
  close: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.soft,
  },
  header: { paddingHorizontal: space.lg, paddingBottom: space.md },
  content: { paddingHorizontal: space.lg },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingTop: space.sm,
  },
  title: {
    flex: 1,
    fontFamily: font.family.bold,
    fontSize: 17,
    lineHeight: 24,
    color: colors.wire.ink,
  },
  badgeRow: { flexDirection: "row", marginTop: space.md },
  note: {
    marginTop: space.sm,
    fontFamily: font.family.regular,
    fontSize: 13,
    lineHeight: 19,
    color: colors.wire.text,
  },
  group: { marginTop: space.md },
  muted: {
    fontFamily: font.family.regular,
    fontSize: 13,
    lineHeight: 19,
    color: colors.muted,
  },
  small: {
    fontFamily: font.family.regular,
    fontSize: 11,
    lineHeight: 16,
    color: colors.muted,
    textAlign: "center",
  },
  error: { marginTop: space.md },
  actions: { marginTop: space.lg, gap: space.sm },
  divider: { height: 1, backgroundColor: colors.wire.border, marginHorizontal: -space.lg, marginVertical: space.xs },
  disconnect: {
    height: 48,
    paddingHorizontal: 16,
    borderRadius: 999,
    backgroundColor: colors.redFill,
    alignItems: "center",
    justifyContent: "center",
  },
  disconnectText: { includeFontPadding: false, fontFamily: font.family.semi, fontSize: 14, color: colors.onAccent },
  reconnect: {
    height: 48,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: colors.wire.line,
    borderRadius: 999,
    backgroundColor: colors.panel,
    alignItems: "center",
    justifyContent: "center",
  },
  reconnectText: { includeFontPadding: false, fontFamily: font.family.semi, fontSize: 14, color: colors.wire.strong },
  request: {
    height: 48,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: colors.wire.line,
    borderRadius: 999,
    backgroundColor: colors.panel,
    alignItems: "center",
    justifyContent: "center",
  },
  requestText: {
    includeFontPadding: false,
    fontFamily: font.family.semi,
    fontSize: 14,
    color: colors.wire.strong,
  },
  dim: { opacity: 0.55 },
});
