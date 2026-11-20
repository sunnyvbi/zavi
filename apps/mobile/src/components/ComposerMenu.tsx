import { useState } from "react";
import { ActivityIndicator, Alert, Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { CHANNELS, connectInfoFor } from "@zavi/shared";
import { ChannelLogo } from "./channels/ChannelGlyph";
import { openConnectInBrowser, startComposio, startOAuth } from "../features/connectors/api";
import { findConnectorRow, planConnect } from "../features/connectors/connectPlan";
import { useConnectorRows } from "../features/connectors/useConnectorRows";
import {
  MENTION_CONNECTABLE,
  filterMentions,
  filterSlash,
  type SlashCommand,
} from "../features/agents/composerTools";
import { filterTenantCommands, type TenantCommand } from "../features/agents/tenantCommands";
import { font, radius, space, type Colors } from "../theme/tokens";
import { useStyles, useTheme } from "../theme/theme";

export type MentionPick = { slug: string; name: string; executor: string };

export function SlashMenu({
  query,
  tenantCommands = [],
  onPick,
  onPickTenant,
}: {
  query: string;
  tenantCommands?: readonly TenantCommand[];
  onPick: (c: SlashCommand) => void;
  onPickTenant?: (c: TenantCommand) => void;
}) {
  const styles = useStyles(makeStyles);
  const items = filterSlash(query);
  const yours = filterTenantCommands(query, tenantCommands);
  if (items.length === 0 && yours.length === 0) return null;
  return (
    <MenuFrame label={items.length > 0 ? "Shortcuts" : "Your commands"}>
      {items.map((c) => (
        <Pressable
          key={c.kind}
          style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          onPress={() => onPick(c)}
          accessibilityRole="button"
          accessibilityHint={c.description}
        >
          <View style={styles.rowText}>
            <View style={styles.slashHead}>
              <Text style={styles.rowTitle}>{c.label}</Text>
              <Text style={styles.command}>{c.argHint ? `${c.command} ${c.argHint}` : c.command}</Text>
            </View>
            <Text style={styles.rowSub}>{c.description}</Text>
          </View>
        </Pressable>
      ))}
      {items.length > 0 && yours.length > 0 ? <Text style={styles.sectionLabel}>Your commands</Text> : null}
      {yours.map((c) => (
        <Pressable
          key={`own:${c.slug}`}
          style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          onPress={() => onPickTenant?.(c)}
          accessibilityRole="button"
          accessibilityHint={c.description || undefined}
        >
          <View style={styles.rowText}>
            <View style={styles.slashHead}>
              <Text style={styles.rowTitle}>{c.name}</Text>
              <Text style={styles.command}>{`/${c.slug}`}</Text>
            </View>
            {c.description ? <Text style={styles.rowSub}>{c.description}</Text> : null}
          </View>
        </Pressable>
      ))}
    </MenuFrame>
  );
}

export function MentionMenu({ query, onPick }: { query: string; onPick: (c: MentionPick) => void }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const items = filterMentions(CHANNELS, query);
  const { rows, refresh } = useConnectorRows();
  const [opening, setOpening] = useState<string | null>(null);
  if (items.length === 0) return null;

  async function connect(slug: string) {
    const info = connectInfoFor(slug);
    if (!info || opening) return;
    const plan = planConnect(slug, info);
    setOpening(slug);
    try {
      if (plan.kind === "oauth" || plan.kind === "composio") {
        const url = plan.kind === "oauth" ? await startOAuth(plan.path) : await startComposio(plan.toolkit);
        await openConnectInBrowser(url);
      } else if (plan.kind === "web") {
        await Linking.openURL(plan.url);
      }
    } catch {
      Alert.alert("Couldn't open the connection", "Please try again.");
    } finally {
      setOpening(null);
      refresh();
    }
  }

  return (
    <MenuFrame label="Channels">
      {items.map((c) => {
        const connector = c.connectors[0];
        const offerConnect =
          !!rows && !!connector && MENTION_CONNECTABLE.has(connector) && !findConnectorRow(rows, connector);
        return (
          <Pressable
            key={c.slug}
            style={({ pressed }) => [styles.row, styles.mentionRow, pressed && styles.rowPressed]}
            onPress={() => onPick({ slug: c.slug, name: c.name, executor: c.executor })}
            accessibilityRole="button"
            accessibilityLabel={offerConnect ? `${c.name}, not connected` : c.name}
          >
            <ChannelLogo slug={c.slug} size={28} />
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>{c.name}</Text>
              {offerConnect ? <Text style={styles.rowSub}>Not connected</Text> : null}
            </View>
            {offerConnect ? (
              <Pressable
                style={({ pressed }) => [styles.connect, pressed && styles.rowPressed]}
                onPress={() => void connect(connector)}
                disabled={!!opening}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel={`Connect ${c.name}`}
              >
                {opening === connector ? (
                  <ActivityIndicator size="small" color={colors.onInk} />
                ) : (
                  <Text style={styles.connectText}>Connect</Text>
                )}
              </Pressable>
            ) : null}
          </Pressable>
        );
      })}
    </MenuFrame>
  );
}

function MenuFrame({ label, children }: { label: string; children: React.ReactNode }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.menu}>
      <Text style={styles.label}>{label}</Text>
      <ScrollView keyboardShouldPersistTaps="always" style={styles.scroll} nestedScrollEnabled>
        {children}
      </ScrollView>
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  menu: {
    marginHorizontal: space.md,
    marginBottom: space.xs,
    paddingTop: space.sm,
    paddingBottom: space.xs,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.lg + 5,
    backgroundColor: colors.panel,
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  scroll: { maxHeight: 260 },
  label: {
    paddingHorizontal: space.md,
    paddingBottom: space.xs,
    fontSize: font.size.sm,
    fontFamily: font.family.medium,
    color: colors.muted,
  },
  sectionLabel: {
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    paddingBottom: space.xs,
    fontSize: font.size.sm,
    fontFamily: font.family.medium,
    color: colors.muted,
  },
  row: { paddingHorizontal: space.md, paddingVertical: space.sm },
  mentionRow: { flexDirection: "row", alignItems: "center", gap: space.md },
  rowPressed: { opacity: 0.6 },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  slashHead: { flexDirection: "row", alignItems: "baseline", gap: space.sm },
  rowTitle: { flex: 1, fontSize: 15, fontFamily: font.family.medium, color: colors.ink },
  command: { fontSize: font.size.sm, fontFamily: font.family.regular, color: colors.muted },
  rowSub: { fontSize: font.size.sm, lineHeight: 17, fontFamily: font.family.regular, color: colors.muted },
  connect: {
    minWidth: 76,
    height: 30,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    backgroundColor: colors.ink,
    alignItems: "center",
    justifyContent: "center",
  },
  connectText: { fontSize: font.size.md, fontFamily: font.family.semi, color: colors.onInk },
});
