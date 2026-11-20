import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Keyboard, Pressable, StyleSheet, Text, View } from "react-native";
import type { BottomSheetModal } from "@gorhom/bottom-sheet";
import { ConnectionSheet } from "../connections/ConnectionSheet";
import { ConnectorTile } from "../connections/ConnectorLogo";
import { ZaviTextField } from "../ZaviTextField";
import { Icon } from "../Icon";
import { PrimaryButton, SecondaryButton } from "../settings/SettingsUI";
import { showDialog } from "../DialogHost";
import { useConnections, useRefreshConnections } from "../../features/connectors/useConnections";
import { useComposioToolkits, REQUESTED_NOTE } from "../../features/connectors/composioApps";
import { connectorUses } from "../../features/connectors/catalog";
import { buildConnections, type Connection } from "../../features/connectors/health";
import { purposeFor } from "../../features/connectors/webCatalog";
import { findConnectorRow } from "../../features/connectors/connectPlan";
import { connectedNames, isConnected, searchConnectors, type SetupConnector } from "../../features/setup/connectors";
import * as copy from "../../features/setup/copy";
import { FooterRow, SetupFrame, StatusPill } from "./SetupUI";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

export function ConnectorsStep({
  header,
  reopened,
  onContinue,
  onSkip,
}: {
  header: ReactNode;
  reopened: boolean;
  onContinue: () => Promise<void> | void;
  onSkip: () => Promise<void> | void;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const q = useConnections();
  const refresh = useRefreshConnections();
  const apps = useComposioToolkits();
  const sheet = useRef<BottomSheetModal>(null);
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);

  const rows = useMemo(() => q.data?.rows ?? [], [q.data]);
  const toolkits = useMemo(() => apps.data?.toolkits ?? [], [apps.data]);
  const requested = useMemo(() => new Set(apps.data?.requested ?? []), [apps.data]);
  const shown = useMemo(() => searchConnectors(query, toolkits), [query, toolkits]);
  const names = connectedNames(rows, toolkits);

  const open = useMemo<Connection | null>(() => {
    if (!openSlug) return null;
    const tile = shown.find((c) => c.slug === openSlug);
    const row = findConnectorRow(rows, openSlug);
    const slug = row?.slug ?? openSlug;
    const label = tile?.name ?? openSlug;
    const [built] = buildConnections({
      rows: rows.filter((r) => r.slug === slug),
      suggested: [slug],
      labelFor: () => label,
      usedByFor: connectorUses,
      slackMissing: q.data?.slackMissing,
      lastSync: q.data?.lastSync,
      now: Date.now(),
    });
    if (!built) return null;
    const app = slug.startsWith("composio.") ? toolkits.find((t) => `composio.${t.slug}` === slug) : undefined;
    if (!app) return built;
    const comingSoon = !row && app.connectable === false;
    const isRequested = requested.has(app.slug);
    return {
      ...built,
      logoUrl: app.logo,
      comingSoon,
      requested: isRequested,
      purpose: comingSoon && isRequested ? REQUESTED_NOTE : purposeFor(app.slug, app.name),
    };
  }, [openSlug, shown, rows, q.data, toolkits, requested]);

  const openSheet = useCallback((c: SetupConnector) => {
    setOpenSlug(c.slug);
    sheet.current?.present();
  }, []);

  const run = async (fn: () => Promise<void> | void) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  const skip = async () => {
    if (reopened) return run(onSkip);
    const ok = await showDialog({
      title: copy.SKIP2_TITLE,
      message: copy.SKIP2_BODY,
      confirmLabel: copy.SKIP_YES,
      cancelLabel: copy.SKIP_NO,
    });
    if (ok) await run(onSkip);
  };

  const footer = (
    <FooterRow note={names.length > 0 ? names.join(", ") : null}>
      <SecondaryButton
        label={reopened ? "Back" : copy.SKIP_STEP}
        onPress={() => {
          Keyboard.dismiss();
          void skip();
        }}
        disabled={busy}
        style={styles.half}
      />
      <PrimaryButton
        label={reopened ? "Done" : copy.continueLabel(names.length)}
        onPress={() => {
          Keyboard.dismiss();
          void run(onContinue);
        }}
        disabled={!reopened && names.length === 0}
        busy={busy}
        busyLabel={copy.SAVING_LABEL}
        style={styles.half}
      />
    </FooterRow>
  );

  return (
    <>
      <SetupFrame header={header} footer={footer}>
        <View style={styles.search}>
          <ZaviTextField
            value={query}
            onChangeText={setQuery}
            placeholder={copy.SEARCH_PLACEHOLDER}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            multiline={false}
            accessibilityLabel="Search connectors"
            style={query ? styles.searchInputClearable : null}
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

        <Text style={styles.caption}>{query.trim() ? copy.results(shown.length) : copy.COMPACT_HEADING}</Text>
        {q.isError && !q.data ? <Text style={styles.error}>{copy.CONNECTORS_LOAD_FAILED}</Text> : null}

        {shown.length > 0 ? (
          <View style={styles.list}>
            {shown.map((c, i) => {
              const on = isConnected(rows, c.slug);
              const app = c.slug.startsWith("composio.") ? toolkits.find((t) => `composio.${t.slug}` === c.slug) : undefined;
              const soon = !on && app?.connectable === false;
              return (
                <Pressable
                  key={c.slug}
                  onPress={() => {
                    Keyboard.dismiss();
                    openSheet(c);
                  }}
                  style={({ pressed }) => [styles.tile, i > 0 && styles.divider, pressed && styles.tilePressed]}
                  accessibilityRole="button"
                  accessibilityLabel={on ? `${c.name} connected` : `Connect ${c.name}`}
                >
                  <ConnectorTile slug={c.slug} label={c.name} size={36} logoUrl={app?.logo} />
                  <View style={styles.flex}>
                    <Text style={styles.name} numberOfLines={1}>
                      {c.name}
                    </Text>
                    <Text style={styles.what} numberOfLines={2}>
                      {c.what}
                    </Text>
                  </View>
                  <StatusPill label={on ? copy.CONNECTED : soon ? copy.COMING_SOON : copy.CONNECT} tone={on ? "ok" : "neutral"} />
                </Pressable>
              );
            })}
          </View>
        ) : (
          <Text style={styles.empty}>{copy.noAppFound(query.trim())}</Text>
        )}
      </SetupFrame>

      <ConnectionSheet
        ref={sheet}
        connection={open}
        row={q.data?.rows.find((r) => r.slug === open?.slug)}
        slackWorkspaces={q.data?.slackWorkspaces}
        whatsappHandsets={q.data?.whatsappHandsets}
        canManage
        onRefresh={() => {
          Keyboard.dismiss();
          void refresh();
        }}
        onDisconnected={() => {
          Keyboard.dismiss();
          sheet.current?.dismiss();
          void refresh();
        }}
      />
    </>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    flex: { flex: 1, minWidth: 0 },
    half: { flex: 1, marginTop: 0, minHeight: 48, borderRadius: radius.md },
    search: { marginTop: space.xs, justifyContent: "center" },
    searchInputClearable: { paddingRight: 44 },
    searchClear: {
      position: "absolute",
      right: space.md,
      width: 22,
      height: 22,
      borderRadius: 11,
      backgroundColor: colors.soft,
      alignItems: "center",
      justifyContent: "center",
    },
    searchClearPressed: { opacity: 0.7 },
    caption: {
      marginTop: space.lg,
      marginBottom: space.sm,
      fontFamily: font.family.semi,
      fontSize: 12,
      lineHeight: 16,
      color: colors.muted,
      textTransform: "uppercase",
      letterSpacing: 0.4,
    },
    error: { fontFamily: font.family.medium, fontSize: 14, lineHeight: 20, color: colors.red, marginBottom: space.sm },
    list: { borderWidth: 1, borderColor: colors.line, borderRadius: radius.lg, overflow: "hidden" },
    tile: { flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.md, paddingVertical: space.md },
    tilePressed: { backgroundColor: colors.soft },
    divider: { borderTopWidth: 1, borderTopColor: colors.line },
    name: { fontFamily: font.family.semi, fontSize: 14, lineHeight: 18, color: colors.ink },
    what: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.textSecondary },
    empty: {
      fontFamily: font.family.regular,
      fontSize: 14,
      lineHeight: 20,
      color: colors.textSecondary,
      backgroundColor: colors.soft,
      borderRadius: radius.md,
      padding: space.md,
    },
  });
