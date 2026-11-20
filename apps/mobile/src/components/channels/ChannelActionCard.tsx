import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { receiptLinkLabel } from "@zavi/shared";
import type { ChannelAction } from "../../features/channels/types";
import { emailCardUrl } from "../../features/channels/api";
import { useMyRole } from "../../features/settings/api";
import { cardMainButton, cardTag, deliverableCaption, execLine } from "../../features/channels/channelPage";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";
import { ChannelIcon, ChannelLogo } from "./ChannelGlyph";
import { CardBullets } from "./CardBullets";

export type ChannelActionCardProps = {
  action: ChannelAction;
  actionType?: string | null;
  onMarkComplete: () => void;
  busy: boolean;
  onReview: () => void;
  onDismiss?: () => void;
  done?: boolean;
};

export function ChannelActionCard({ action, actionType, onMarkComplete, busy, onReview, onDismiss, done = false }: ChannelActionCardProps) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const router = useRouter();
  const exec = execLine(action.execStatus, action.channelName, action.execFixText);
  const zaviChange = action.executable || action.cardKind === "executes";
  const doneWords = action.cardKind ? action.doneLabel ?? "Done" : "I did this";
  const main = cardMainButton(action, useMyRole());
  const mainFilled = !!main && main.does !== "web_only";
  const pressMain = () => {
    if (main?.does === "email") void WebBrowser.openBrowserAsync(emailCardUrl(action.id)).catch(() => undefined);
    else onReview();
  };
  const proseOnly = !!action.copy && action.why === null;
  const lead = action.copy?.lead || action.why || null;
  const flags = [action.rewritten ? "Rewritten" : null, action.weeksOld ? `${action.weeksOld} wk old` : null].filter(Boolean);
  const askZavi = () =>
    router.push({
      pathname: "/chat",
      params: {
        channel: action.slug,
        channel_action: action.action_source === "channel_action" ? action.id : undefined,
        prefill: `About this action on ${action.channelName}: "${action.title}". `,
        back: "1",
      },
    });

  return (
    <View style={styles.card}>
      <View style={styles.top}>
        <ChannelLogo slug={action.slug} size={16} />
        {action.blocking ? (
          <View style={styles.blocking} accessibilityLabel="Blocking: other cards on this channel wait on this">
            <Text style={styles.blockingText}>Blocking</Text>
          </View>
        ) : null}
        <Text style={styles.topText} numberOfLines={1}>
          {[cardTag(actionType, action.intent), ...flags].join(" · ")}
        </Text>
      </View>
      <Text style={styles.title}>{action.title}</Text>
      {lead ? (
        <Text style={styles.lead} numberOfLines={2}>
          {lead}
        </Text>
      ) : null}
      {action.copy && !(action.text && !proseOnly) ? <CardBullets copy={action.copy} executable={zaviChange} compact /> : null}
      {action.text && !proseOnly ? (
        <View style={styles.pane}>
          {lead ? <Text style={styles.caption}>{deliverableCaption(actionType, action.deliverableLabel)}</Text> : null}
          <Text style={styles.preview} numberOfLines={2}>
            {action.text}
          </Text>
        </View>
      ) : null}

      {exec ? (
        <View style={[styles.exec, exec.tone === "failed" && styles.execFailed]} accessibilityRole={exec.tone === "failed" ? "alert" : undefined}>
          {exec.tone === "working" ? (
            <ActivityIndicator size="small" color={colors.muted} />
          ) : (
            <ChannelIcon name={exec.tone === "done" ? "check" : "close"} size={14} color={exec.tone === "done" ? colors.green : colors.red} />
          )}
          <View style={styles.flex}>
            <Text style={styles.execText}>{exec.text}</Text>
            {exec.fix ? <Text style={styles.execText}>{exec.fix}</Text> : null}
            {exec.tone === "done" && action.execReceipt ? <Receipt receipt={action.execReceipt} /> : null}
          </View>
        </View>
      ) : null}

      {done ? null : (
      <View style={styles.footer}>
        {main?.does === "web_only" ? (
          <Text style={styles.actionMuted}>{main.label}</Text>
        ) : main ? (
          <Pressable
            style={[styles.main, busy && styles.disabled]}
            onPress={pressMain}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel={`${main.label}: ${action.title}`}
            hitSlop={8}
          >
            <Text style={styles.mainText}>{main.label}</Text>
          </Pressable>
        ) : null}
        {zaviChange ? null : (
          <Pressable
            style={[styles.action, busy && styles.disabled]}
            onPress={onMarkComplete}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel={`${doneWords}: ${action.title}`}
            accessibilityState={{ disabled: busy, busy }}
            hitSlop={8}
          >
            <ChannelIcon name="check" size={13} color={colors.ink} />
            <Text style={styles.actionText}>{doneWords}</Text>
          </Pressable>
        )}
        <Pressable style={styles.action} onPress={askZavi} accessibilityRole="button" accessibilityLabel={`Ask Zavi about ${action.title}`} hitSlop={8}>
          <Text style={styles.actionMuted}>Ask Zavi</Text>
        </Pressable>
        {onDismiss ? (
          <Pressable
            style={[styles.action, busy && styles.disabled]}
            onPress={onDismiss}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel={`Dismiss ${action.title}`}
            hitSlop={8}
          >
            <Text style={styles.actionMuted}>Dismiss</Text>
          </Pressable>
        ) : null}
        {}
        <Pressable style={mainFilled ? styles.detailsQuiet : styles.details} onPress={onReview} accessibilityRole="button" accessibilityLabel={`Details: ${action.title}`}>
          <Text style={mainFilled ? styles.actionMuted : styles.detailsText}>Details</Text>
        </Pressable>
      </View>
      )}
    </View>
  );
}

export function Receipt({ receipt }: { receipt: NonNullable<ChannelAction["execReceipt"]> }) {
  const styles = useStyles(makeStyles);
  return (
    <Text style={styles.execText}>
      {receipt.line}
      {receipt.url ? (
        <>
          {"  "}
          <Text style={styles.receiptLink} accessibilityRole="link" onPress={() => void Linking.openURL(receipt.url as string).catch(() => undefined)}>
            {receiptLinkLabel(receipt.url)}
          </Text>
        </>
      ) : null}
    </Text>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    flex: { flex: 1 },
    card: {
      marginTop: 10,
      padding: 14,
      gap: 6,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: 13,
      backgroundColor: colors.bg,
    },
    top: { flexDirection: "row", alignItems: "center", gap: 6 },
    topText: { flexShrink: 1, includeFontPadding: false, fontFamily: font.family.medium, fontSize: 12, color: colors.muted },
    blocking: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: radius.pill, backgroundColor: colors.status.amberBg },
    blockingText: { fontFamily: font.family.semi, fontSize: 11, color: colors.status.amberText },
    title: { includeFontPadding: false, fontFamily: font.family.semi, fontSize: 15, lineHeight: 20, color: colors.ink },
    lead: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 19, color: colors.textSecondary },
    pane: { gap: 4, marginTop: 2, padding: 10, borderRadius: radius.sm, backgroundColor: colors.soft },
    caption: { fontFamily: font.family.semi, fontSize: 11, letterSpacing: 0.5, color: colors.muted },
    preview: { fontFamily: font.family.regular, includeFontPadding: false, fontSize: 13, lineHeight: 20, color: colors.ink },
    exec: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: space.sm,
      marginTop: 4,
      padding: 10,
      borderRadius: radius.sm,
      backgroundColor: colors.soft,
    },
    execFailed: { backgroundColor: colors.status.redBg },
    execText: { fontFamily: font.family.medium, fontSize: 13, lineHeight: 19, color: colors.ink },
    footer: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      columnGap: 14,
      marginTop: 6,
      paddingTop: 10,
      borderTopWidth: 1,
      borderTopColor: colors.line,
    },
    action: { flexDirection: "row", alignItems: "center", gap: 5, minHeight: 36 },
    main: {
      minHeight: 36,
      paddingVertical: 6,
      paddingHorizontal: 12,
      borderRadius: 8,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.ink,
    },
    mainText: { includeFontPadding: false, fontFamily: font.family.semi, fontSize: 12, color: colors.onInk },
    receiptLink: { fontFamily: font.family.semi, textDecorationLine: "underline", color: colors.ink },
    actionText: { includeFontPadding: false, fontFamily: font.family.semi, fontSize: 12, color: colors.ink },
    actionMuted: { includeFontPadding: false, fontFamily: font.family.medium, fontSize: 12, color: colors.muted },
    disabled: { opacity: 0.4 },
    details: {
      marginLeft: "auto",
      minHeight: 36,
      paddingVertical: 6,
      paddingHorizontal: 12,
      borderRadius: 8,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.ink,
    },
    detailsQuiet: { marginLeft: "auto", minHeight: 36, justifyContent: "center" },
    detailsText: { includeFontPadding: false, fontFamily: font.family.semi, fontSize: 12, color: colors.onInk },
  });
