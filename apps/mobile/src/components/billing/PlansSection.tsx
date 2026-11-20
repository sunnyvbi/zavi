import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "../Icon";
import { openBilling } from "../../features/agents/billingLink";
import { effectiveTier, type Credits } from "../../features/settings/api";
import { apiJson } from "../../lib/api";
import { track } from "../../lib/analytics";
import { font, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

type PricingTier = { slug: string; name: string; usd: number; monthly_credits: number; daily_credits: number };
type Pricing = { tiers: PricingTier[] };

const BULLETS: Record<string, string[]> = {
  free: ["Chat with Zavi", "Research and analysis"],
  starter: [
    "Everything in Free",
    "SEO, AI search, blog, LinkedIn, Reddit, X, Instagram and Pinterest",
    "Build sites and apps, Ads Manager",
  ],
  growth: ["Everything in Starter", "Creator UGC, TikTok and YouTube organic"],
  pro: [
    "Everything in Growth",
    "Paid ads on Google, Meta, TikTok, LinkedIn, Reddit, YouTube and ChatGPT",
    "Engineer, fundraising, email and SMS",
  ],
};
const POPULAR = "growth";

function usePricing() {
  return useQuery({
    queryKey: ["public-pricing"],
    queryFn: () => apiJson<Pricing>("/api/public/pricing"),
    staleTime: 60_000,
  });
}

const num = (v: number) => v.toLocaleString("en-US");

function noteFor(t: PricingTier): string {
  return t.monthly_credits > 0
    ? `${num(t.monthly_credits)} a month + ${num(t.daily_credits)} a day`
    : `${num(t.daily_credits)} credits a day`;
}

function creditsBullet(t: PricingTier): string {
  return t.monthly_credits > 0
    ? `${num(t.monthly_credits)} credits a month plus ${num(t.daily_credits)} a day`
    : `${num(t.daily_credits)} credits a day, no card`;
}

function ExternalGlyph() {
  const { colors } = useTheme();
  return (
    <Svg width={14} height={14} viewBox="0 0 24 24">
      <Path
        d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"
        stroke={colors.onInk}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}

function LockGlyph() {
  const { colors } = useTheme();
  const p = { stroke: colors.wire.mute, strokeWidth: 1.9, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, fill: "none" };
  return (
    <Svg width={14} height={14} viewBox="0 0 24 24">
      <Rect x={4} y={11} width={16} height={10} rx={2} {...p} />
      <Path d="M8 11V7a4 4 0 0 1 8 0v4" {...p} />
    </Svg>
  );
}

function InkBadge({ label }: { label: string }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.badge}>
      <Text style={styles.badgeText}>{label}</Text>
    </View>
  );
}

export function PlansSection({ c, showLinks }: { c: Credits; showLinks: boolean }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const { data } = usePricing();
  const current = effectiveTier(c);

  if (!data) return null;

  return (
    <View>
      <Text style={styles.heading}>Plans</Text>
      <View style={styles.list}>
        {data.tiers.map((t) => {
          const isCurrent = t.slug === current;
          const isPopular = t.slug === POPULAR && !isCurrent;
          const priceShort = `$${t.usd}/mo`;
          return (
            <View
              key={t.slug}
              style={[
                styles.card,
                isCurrent && styles.cardCurrent,
                isPopular && styles.cardPopular,
              ]}
            >
              {isPopular ? (
                <View style={styles.popularBadge}>
                  <InkBadge label="Popular" />
                </View>
              ) : null}

              {}
              <View style={styles.headRow}>
                <Text style={styles.name}>{t.name}</Text>
                {isCurrent ? (
                  <InkBadge label="Current" />
                ) : (
                  <Text style={styles.price}>{t.usd === 0 ? "$0" : priceShort}</Text>
                )}
              </View>
              <Text style={styles.note}>{noteFor(t)}</Text>

              <Text style={styles.included}>What's included</Text>
              <View style={styles.bullets}>
                {[...(BULLETS[t.slug] ?? []), creditsBullet(t)].map((line) => (
                  <View key={line} style={styles.bulletRow}>
                    <View style={styles.check}>
                      <Icon name="check" size={15} color={colors.wire.faint} strokeWidth={2} />
                    </View>
                    <Text style={styles.bulletText}>{line}</Text>
                  </View>
                ))}
              </View>

              {}
              <View style={styles.action}>
                {isCurrent ? (
                  <Text style={styles.statusCurrent}>Your current plan</Text>
                ) : t.slug === "free" ? (
                  <Text style={styles.statusFree}>Free on every workspace.</Text>
                ) : showLinks ? (
                  <Pressable
                    onPress={() => {
                      track("pricing_plan_selected", { tier: t.slug });
                      openBilling();
                    }}
                    accessibilityRole="button"
                    style={({ pressed }) => [styles.move, pressed && styles.pressedInk]}
                  >
                    <Text style={styles.moveText}>{`Move to ${t.name}, ${priceShort}`}</Text>
                    <ExternalGlyph />
                  </Pressable>
                ) : (
                  <View style={styles.lockRow}>
                    <LockGlyph />
                    <Text style={styles.lockText}>Owner or admin changes the plan</Text>
                  </View>
                )}
              </View>
            </View>
          );
        })}
      </View>

      {}
      <View style={styles.enterprise}>
        <View style={styles.enterpriseText}>
          <Text style={styles.enterpriseName}>Enterprise</Text>
          <Text style={styles.enterpriseSub}>More credits, invoicing, security review and an SLA.</Text>
        </View>
        <Pressable
          onPress={() => {
            track("pricing_plan_selected", { tier: "enterprise" });
            openBilling();
          }}
          accessibilityRole="button"
          style={({ pressed }) => [styles.contact, pressed && styles.pressedTint]}
        >
          <Text style={styles.contactText}>Contact sales</Text>
        </Pressable>
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  heading: { marginBottom: 10, fontSize: 15, fontFamily: font.family.semi, color: colors.wire.ink },
  list: { gap: 12 },
  card: {
    borderWidth: 1,
    borderColor: colors.wire.line,
    borderRadius: 16,
    padding: 16,
    backgroundColor: colors.surfaceRaised,
  },
  cardCurrent: { borderColor: colors.wire.ink, backgroundColor: colors.wire.head },
  cardPopular: {
    borderColor: colors.wire.border,
    paddingTop: 20,
    marginTop: 6,
    shadowColor: "#101214",
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.35,
    shadowRadius: 15,
    elevation: Platform.OS === "android" ? 4 : 0,
  },
  popularBadge: { position: "absolute", top: -11, left: 14 },
  badge: {
    alignSelf: "flex-start",
    borderRadius: 999,
    paddingVertical: 2,
    paddingHorizontal: 9,
    backgroundColor: colors.wire.ink,
  },
  badgeText: { fontSize: 12, lineHeight: 18, fontFamily: font.family.semi, color: colors.onInk },
  headRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  name: { fontSize: 16, fontFamily: font.family.semi, color: colors.wire.ink },
  price: { fontSize: 14, fontFamily: font.family.semi, color: colors.wire.text },
  note: { marginTop: 2, fontSize: 13, fontFamily: font.family.regular, color: colors.wire.mute },
  included: {
    marginTop: 12,
    marginBottom: 6,
    fontSize: 12,
    fontFamily: font.family.semi,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    color: colors.wire.faint,
  },
  bullets: { gap: 6 },
  bulletRow: { flexDirection: "row", gap: 8 },
  check: { marginTop: 2 },
  bulletText: { flex: 1, fontSize: 14, lineHeight: 19, fontFamily: font.family.regular, color: colors.wire.sub },
  action: { marginTop: 14 },
  statusCurrent: { fontSize: 14, fontFamily: font.family.medium, color: colors.wire.mute },
  statusFree: { fontSize: 14, fontFamily: font.family.regular, color: colors.wire.mute },
  move: {
    height: 42,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: 999,
    backgroundColor: colors.wire.ink,
  },
  moveText: { fontSize: 14, fontFamily: font.family.semi, color: colors.onInk },
  pressedInk: { opacity: 0.85 },
  pressedTint: { backgroundColor: colors.wire.tint },
  lockRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  lockText: { fontSize: 13, fontFamily: font.family.regular, color: colors.wire.mute },
  enterprise: {
    marginTop: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderWidth: 1,
    borderColor: colors.wire.line,
    borderRadius: 16,
    padding: 16,
  },
  enterpriseText: { flex: 1, minWidth: 0 },
  enterpriseName: { fontSize: 15, fontFamily: font.family.semi, color: colors.wire.ink },
  enterpriseSub: { marginTop: 2, fontSize: 13, lineHeight: 18, fontFamily: font.family.regular, color: colors.wire.sub },
  contact: {
    height: 38,
    paddingHorizontal: 12,
    justifyContent: "center",
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.wire.line,
  },
  contactText: { fontSize: 14, fontFamily: font.family.semi, color: colors.wire.text },
});
