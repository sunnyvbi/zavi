import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { ChannelLogo } from "../channels/ChannelGlyph";
import { Icon } from "../Icon";
import { PLAN_NAME, type GeoView } from "../../features/analytics/model";
import { font, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";
import { Card, Muted, ProgressRow, SmallButton } from "./kit";

export type SourceId = "ads" | "search" | "ai" | "reddit";

export const SOURCE: Record<SourceId, { title: string; from: string; logo: string }> = {
  ads: { title: "Ads", from: "Meta Ads and Google Ads", logo: "meta_ads" },
  search: { title: "Search", from: "Google Search Console", logo: "seo" },
  ai: { title: "AI search", from: "Zavi's read of your site", logo: "geo" },
  reddit: { title: "Reddit", from: "Zavi's scan of public Reddit", logo: "reddit_organic" },
};

function Head({ id, chevron, right }: { id: SourceId; chevron: boolean; right?: ReactNode }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const s = SOURCE[id];
  return (
    <View style={styles.head}>
      <ChannelLogo slug={s.logo} size={36} />
      <View style={styles.headText}>
        <Text style={styles.title}>{s.title}</Text>
        <Text style={styles.from} numberOfLines={1}>
          {s.from}
        </Text>
      </View>
      {right ? (
        right
      ) : chevron ? (
        <View style={styles.details}>
          <Text style={styles.detailsText}>Details</Text>
          <View style={styles.chevronRight}>
            <Icon name="chevron" size={16} color={colors.wire.mute} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

export function SourceCard({
  id,
  onOpen,
  headline,
  chart,
  caption,
  lockedTier,
  failed,
  onRetry,
  connectLabel,
  onConnect,
  onPlans,
}: {
  id: SourceId;
  onOpen?: () => void;
  headline?: ReactNode;
  chart: ReactNode;
  caption?: string;
  lockedTier?: keyof typeof PLAN_NAME | null;
  failed?: boolean;
  onRetry?: () => void;
  connectLabel?: string;
  onConnect?: () => void;
  onPlans?: () => void;
}) {
  const styles = useStyles(makeStyles);
  const plansButton = lockedTier && onPlans ? <SmallButton primary label="See plans" onPress={onPlans} /> : undefined;
  const body = (
    <>
      <Head id={id} chevron={!!onOpen} right={plansButton} />
      {headline ? <View style={styles.headline}>{headline}</View> : null}
    </>
  );
  return (
    <Card>
      {onOpen ? (
        <Pressable onPress={onOpen} accessibilityRole="button" accessibilityLabel={`Open ${SOURCE[id].title} detail`}>
          {body}
        </Pressable>
      ) : (
        body
      )}
      {lockedTier ? (
        <View style={styles.block}>
          <Muted>{`${SOURCE[id].title} numbers come with the ${PLAN_NAME[lockedTier]} plan.`}</Muted>
        </View>
      ) : failed ? (
        <View style={styles.block}>
          <Muted>Couldn't load this.</Muted>
          {onRetry ? (
            <View style={styles.action}>
              <SmallButton label="Retry" onPress={onRetry} />
            </View>
          ) : null}
        </View>
      ) : (
        <>
          <View style={styles.block}>{chart}</View>
          {caption ? <Muted style={styles.caption}>{caption}</Muted> : null}
          {connectLabel && onConnect ? (
            <View style={styles.action}>
              <SmallButton primary label={connectLabel} onPress={onConnect} />
            </View>
          ) : null}
        </>
      )}
    </Card>
  );
}

export function GeoBands({ geo, big }: { geo: GeoView; big?: boolean }) {
  return (
    <View style={{ gap: big ? 12 : 8 }}>
      {geo.bands.map((b) => (
        <ProgressRow key={b.key} label={b.label} right={`${b.score}/100`} fraction={b.score / 100} done={b.score >= 100} />
      ))}
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: 12 },
  headText: { flex: 1, minWidth: 0 },
  title: { fontFamily: font.family.semi, fontSize: 15, color: colors.wire.text },
  from: { fontFamily: font.family.regular, fontSize: 12.5, color: colors.wire.mute },
  details: { flexDirection: "row", alignItems: "center", gap: 2 },
  detailsText: { fontFamily: font.family.semi, fontSize: 13, color: colors.wire.ink },
  chevronRight: { transform: [{ rotate: "-90deg" }] },
  headline: { marginTop: 12, flexDirection: "row", alignItems: "baseline", gap: 8, flexWrap: "wrap" },
  block: { marginTop: 12 },
  caption: { marginTop: 10 },
  action: { marginTop: 12 },
});

export const makeHeadlineStyles = (colors: Colors) => StyleSheet.create({
  big: { fontFamily: font.family.semi, fontSize: 22, lineHeight: 28, color: colors.wire.text, fontVariant: ["tabular-nums"] },
  of: { fontFamily: font.family.regular, fontSize: 14, color: colors.wire.mute },
  unit: { fontFamily: font.family.regular, fontSize: 13, color: colors.wire.mute },
});
