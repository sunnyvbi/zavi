import { useCallback, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import type { BottomSheetModal } from "@gorhom/bottom-sheet";
import { BackIcon, Icon } from "../components/Icon";
import { SkeletonBlock } from "../components/Skeleton";
import { useToast } from "../components/Toast";
import { SecondaryButton } from "../components/settings/SettingsUI";
import { ConnectionRow } from "../components/connections/ConnectionsList";
import { ConnectionSheet } from "../components/connections/ConnectionSheet";
import { McpConnectCard } from "../components/connections/McpConnectCard";
import { useConnections, useRefreshConnections, whatsappHandsetsLabel } from "../features/connectors/useConnections";
import { canManageConnectors, connectorLabel, connectorUses } from "../features/connectors/catalog";
import { MESSAGING_SLUGS, messagingConnections } from "../features/connectors/messaging";
import type { Connection } from "../features/connectors/health";
import { useWorkspace } from "../features/workspaces/WorkspaceProvider";
import { font, space, type Colors } from "../theme/tokens";
import { useStyles, useTheme } from "../theme/theme";

export default function Messaging() {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const q = useConnections();
  const refresh = useRefreshConnections();
  const { tenants, activeTenantId } = useWorkspace();
  const canManage = canManageConnectors(tenants.find((t) => t.tenant_id === activeTenantId)?.role);
  const { show, toast } = useToast({ bottom: insets.bottom + 24 }, { fit: "content" });
  const sheet = useRef<BottomSheetModal>(null);
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  const [autoStart, setAutoStart] = useState(false);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => Date.now(), [q.data]);
  const list = useMemo(() => {
    const handsets = whatsappHandsetsLabel(q.data?.whatsappHandsets ?? []);
    return messagingConnections({
      rows: q.data?.rows ?? [],
      labelFor: connectorLabel,
      usedByFor: connectorUses,
      slackMissing: q.data?.slackMissing,
      lastSync: q.data?.lastSync,
      now,
    }).map((c) => (c.slug === "whatsapp" && handsets ? { ...c, detail: handsets } : c));
  }, [q.data, now]);
  const open = list.find((c) => c.slug === openSlug) ?? null;

  const openSheet = useCallback((c: Connection) => {
    setAutoStart(false);
    setOpenSlug(c.slug);
    sheet.current?.present();
  }, []);

  const connectSheet = useCallback((c: Connection) => {
    setAutoStart(true);
    setOpenSlug(c.slug);
    sheet.current?.present();
  }, []);

  function goBack() {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace("/chat");
  }

  return (
    <>
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.header}>
          <Pressable
            style={({ pressed }) => [styles.headerButton, pressed && styles.pressed]}
            onPress={goBack}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Back"
          >
            <BackIcon color={colors.ink} />
          </Pressable>
          <Text style={styles.headerTitle}>Messaging</Text>
          <View style={styles.headerButton} />
        </View>

        <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 20 }]}>
          <Text style={styles.subtitle}>Chat with Zavi in other messaging apps</Text>
          {q.isLoading ? (
            <MessagingSkeleton />
          ) : (
            <>
              {q.isError && !q.data ? (
                <View style={styles.warning} accessibilityRole="alert">
                  <Text style={styles.warningTitle}>Couldn’t load your messaging apps</Text>
                  <Text style={styles.warningBody}>
                    Anything already connected still works — this is a display hiccup, not a disconnection.
                  </Text>
                  <SecondaryButton label="Retry" onPress={() => void q.refetch()} />
                </View>
              ) : (
                <View style={styles.group}>
                  {list.map((c) => (
                    <ConnectionRow
                      key={c.slug}
                      c={c}
                      now={now}
                      onOpen={openSheet}
                      onConnect={canManage ? connectSheet : undefined}
                    />
                  ))}
                </View>
              )}

              <Text style={styles.sectionTitle} accessibilityRole="header">
                MCP
              </Text>
              <Text style={styles.sectionBody}>Run your agents from Claude Code, claude.ai or ChatGPT.</Text>
              <McpConnectCard />
            </>
          )}
        </ScrollView>
      </SafeAreaView>

      <ConnectionSheet
        ref={sheet}
        connection={open}
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

function MessagingSkeleton() {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.group} accessible accessibilityLabel="Loading messaging apps" accessibilityState={{ busy: true }}>
      {MESSAGING_SLUGS.map((slug) => (
        <View key={slug} style={styles.skeletonRow}>
          <SkeletonBlock width={40} height={40} radius={12} />
          <View style={styles.skeletonText}>
            <View style={styles.skeletonTop}>
              <SkeletonBlock width="45%" height={15} />
              <SkeletonBlock width={72} height={22} radius={999} />
            </View>
            <SkeletonBlock width="65%" height={13} style={styles.skeletonSub} />
          </View>
        </View>
      ))}
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: {
    height: 64,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  headerButton: {
    width: 48,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
  },
  pressed: { opacity: 0.7 },
  headerTitle: {
    flex: 1,
    marginHorizontal: space.xs,
    fontFamily: font.family.semi,
    fontSize: 18,
    lineHeight: 24,
    textAlign: "center",
    textAlignVertical: "center",
    includeFontPadding: false,
    color: colors.ink,
  },
  content: { paddingHorizontal: space.lg, paddingTop: 20 },
  subtitle: {
    marginBottom: 20,
    fontFamily: font.family.regular,
    fontSize: 14,
    lineHeight: 20,
    color: colors.textSecondary,
  },
  group: {
    borderWidth: 1,
    borderColor: colors.wire.line,
    borderRadius: 16,
    backgroundColor: colors.panel,
    overflow: "hidden",
  },
  warning: {
    borderWidth: 1,
    borderColor: colors.status.amberLine,
    borderRadius: 16,
    backgroundColor: colors.status.amberBg,
    padding: space.lg,
  },
  warningTitle: { fontFamily: font.family.semi, fontSize: 14, lineHeight: 18, color: colors.status.amberText },
  warningBody: {
    marginTop: 6,
    fontFamily: font.family.regular,
    fontSize: 13,
    lineHeight: 18,
    color: colors.textSecondary,
  },
  sectionTitle: {
    marginTop: space.xl,
    fontFamily: font.family.semi,
    fontSize: 16,
    lineHeight: 22,
    color: colors.ink,
  },
  sectionBody: {
    marginTop: 6,
    marginBottom: space.md,
    fontFamily: font.family.regular,
    fontSize: 13,
    lineHeight: 18,
    color: colors.textSecondary,
  },
  skeletonRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 66,
    padding: space.md,
    marginBottom: -1,
    borderBottomWidth: 1,
    borderBottomColor: colors.wire.tint,
  },
  skeletonText: { flex: 1, minWidth: 0 },
  skeletonTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  skeletonSub: { marginTop: 4 },
});
