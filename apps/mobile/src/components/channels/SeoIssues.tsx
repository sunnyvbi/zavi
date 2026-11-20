import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Icon } from "../Icon";
import { TextLink } from "../growth/StoryKit";
import type { SeoIssueRow } from "../../features/channels/seoKpis";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

const SHOWN = 5;
const SEV_LABEL = { error: "Error", warning: "Warning", notice: "Notice" } as const;

function IssueRow({ issue }: { issue: SeoIssueRow }) {
  const styles = useStyles(makeStyles);
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const who = issue.owner === "founder" ? "You" : issue.owner === "developer" ? "Developer" : null;
  return (
    <View style={styles.row}>
      <View style={styles.head}>
        <Text style={[styles.badge, issue.sev === "error" ? styles.bad : issue.sev === "warning" ? styles.warn : styles.muted]}>
          {SEV_LABEL[issue.sev]}
        </Text>
        <Text style={styles.meta}>{issue.where}</Text>
        {who ? <Text style={[styles.badge, issue.owner === "founder" ? styles.good : styles.muted]}>{who}</Text> : null}
      </View>
      <Text style={styles.title}>{issue.title}</Text>
      {issue.why ? (
        <Text style={styles.why} numberOfLines={open ? undefined : 2}>
          {issue.why}
        </Text>
      ) : null}
      {open ? (
        <View style={styles.detail}>
          {issue.how ? (
            <Text style={styles.why}>
              <Text style={styles.strong}>How to fix: </Text>
              {issue.how}
            </Text>
          ) : null}
          {who ? <Text style={styles.why}>{issue.owner === "founder" ? "You can do this yourself, no developer needed." : "This needs a developer."}</Text> : null}
          <Text style={styles.strong}>Pages</Text>
          {issue.siteWide || issue.pages.length === 0 ? (
            <Text style={styles.why}>The whole site</Text>
          ) : (
            issue.pages.map((u) => (
              <Text key={u} style={styles.page} selectable>
                {u}
              </Text>
            ))
          )}
        </View>
      ) : null}
      <View style={styles.actions}>
        <TextLink label={open ? "Hide" : "How to fix"} expanded={open} onPress={() => setOpen((v) => !v)} accessibilityLabel={`${open ? "Hide" : "How to fix"}: ${issue.title}`} />
        <TextLink
          label="Fix with Zavi"
          onPress={() => router.push({ pathname: "/chat", params: { prefill: issue.fixDraft, back: "1" } })}
          accessibilityLabel={`Ask Zavi to help fix: ${issue.title}`}
        />
      </View>
    </View>
  );
}

export function SeoIssuesCard({ issues }: { issues: { rows: SeoIssueRow[]; empty: string } }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const [showNotices, setShowNotices] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const main = issues.rows.filter((r) => r.sev !== "notice");
  const notices = issues.rows.filter((r) => r.sev === "notice");
  const pool = showNotices ? issues.rows : main;
  const shown = showAll ? pool : pool.slice(0, SHOWN);
  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <Icon name="file" size={16} color={colors.ink} />
        <Text style={styles.cardTitle}>Top issues</Text>
      </View>
      {issues.rows.length === 0 ? <Text style={styles.why}>{issues.empty}</Text> : null}
      {issues.rows.length > 0 && main.length === 0 && !showNotices ? (
        <Text style={styles.why}>Only notices here. Nothing found is hurting how your pages rank.</Text>
      ) : null}
      {shown.map((r) => (
        <IssueRow key={r.id} issue={r} />
      ))}
      {pool.length > SHOWN ? (
        <TextLink label={showAll ? `Show top ${SHOWN}` : `Show all ${pool.length}`} expanded={showAll} onPress={() => setShowAll((v) => !v)} />
      ) : null}
      {notices.length > 0 ? (
        <TextLink
          label={showNotices ? "Hide notices" : `Show ${notices.length} ${notices.length === 1 ? "notice" : "notices"}`}
          expanded={showNotices}
          onPress={() => setShowNotices((v) => !v)}
        />
      ) : null}
      <Text style={styles.small}>Read from your own public pages. No connector needed.</Text>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    card: { marginTop: space.md, padding: space.lg, gap: space.sm, borderWidth: 1, borderColor: colors.line, borderRadius: 16, backgroundColor: colors.panel },
    cardHead: { flexDirection: "row", alignItems: "center", gap: space.sm },
    cardTitle: { fontFamily: font.family.semi, fontSize: 15, color: colors.ink },
    row: { gap: 4, padding: space.md, borderRadius: radius.md, backgroundColor: colors.soft },
    head: { flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" },
    badge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill, overflow: "hidden", fontFamily: font.family.semi, fontSize: 11 },
    bad: { backgroundColor: colors.status.redBg, color: colors.status.redText },
    warn: { backgroundColor: colors.status.amberBg, color: colors.status.amberText },
    good: { backgroundColor: colors.status.greenBg, color: colors.status.greenText },
    muted: { backgroundColor: colors.panel, color: colors.textSecondary },
    meta: { fontFamily: font.family.medium, fontSize: 12, color: colors.muted },
    title: { fontFamily: font.family.semi, fontSize: 14, lineHeight: 19, color: colors.ink },
    why: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 19, color: colors.textSecondary },
    strong: { fontFamily: font.family.semi, fontSize: 13, color: colors.ink },
    detail: { gap: 4, marginTop: 2 },
    page: { fontFamily: font.family.regular, fontSize: 12, lineHeight: 17, color: colors.ink },
    actions: { flexDirection: "row", gap: space.lg, marginTop: 2 },
    small: { fontFamily: font.family.regular, fontSize: 12, lineHeight: 17, color: colors.muted },
  });
