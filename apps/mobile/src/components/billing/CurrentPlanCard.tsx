import { StyleSheet, Text, View } from "react-native";
import { PRICING_CONFIG } from "@zavi/shared";
import { effectiveTier, type Credits } from "../../features/settings/api";
import { font, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

export function n(v: number): string {
  const x = Math.max(0, Math.round(v));
  const units: [number, string][] = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [size, suffix] of units) {
    if (x >= size) {
      const short = Math.floor((x / size) * 10) / 10;
      return `${short.toFixed(1).replace(/\.0$/, "")}${suffix}`;
    }
  }
  return String(x);
}

export function shortDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function planTitle(plan: string | null): string {
  const tier = plan && plan !== "free" ? PRICING_CONFIG.tiers[plan as keyof typeof PRICING_CONFIG.tiers] : undefined;
  if (!tier || !plan || plan === "free") return "Free";
  return `${tier.name} · $${tier.monthly_usd}/mo`;
}

export function planName(plan: string | null): string {
  const tier = plan ? PRICING_CONFIG.tiers[plan as keyof typeof PRICING_CONFIG.tiers] : undefined;
  return tier?.name ?? "Free";
}

export function CurrentPlanCard({ c }: { c: Credits }) {
  const styles = useStyles(makeStyles);
  const resets = shortDate(c.period_end);
  return (
    <View style={styles.card}>
      <Text style={styles.eyebrow}>Current plan</Text>
      <View style={styles.titleRow}>
        <Text style={styles.plan}>{planTitle(effectiveTier(c))}</Text>
        {c.soft_warn ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>Low</Text>
          </View>
        ) : null}
      </View>

      {c.unlimited ? (
        <Text style={styles.unlimited}>Unlimited credits. This workspace is not limited by credits.</Text>
      ) : (
        <>
          <View style={styles.bigRow}>
            <Text style={styles.big}>{n(c.effective_available_display)}</Text>
            <Text style={styles.bigLabel}>credits available now</Text>
          </View>

          {c.included_allowance > 0 ? (
            <Meter
              label="Monthly credits"
              value={`${n(c.included_remaining)} left of ${n(c.included_allowance)}`}
              fraction={c.included_remaining / c.included_allowance}
              warn={c.soft_warn}
            />
          ) : null}
          {c.daily_allowance > 0 ? (
            <Meter
              label="Free today"
              value={`${n(c.daily_remaining)} left of ${n(c.daily_allowance)}`}
              fraction={c.daily_remaining / c.daily_allowance}
              warn={c.daily_remaining === 0}
            />
          ) : null}

          <View style={styles.facts}>
            {c.purchased_balance > 0 ? (
              <Text style={styles.fact}>{`Purchased credits: ${n(c.purchased_balance)}, never expire`}</Text>
            ) : null}
            {c.reserved > 0 ? <Text style={styles.fact}>{`Held for running work: ${n(c.reserved)}`}</Text> : null}
            <Text style={styles.fact}>
              {c.included_allowance > 0 && resets
                ? `Monthly credits reset ${resets}. Daily credits reset every day and don't roll over.`
                : "Daily credits reset every day and don't roll over."}
            </Text>
          </View>
        </>
      )}
    </View>
  );
}

function Meter({ label, value, fraction, warn }: { label: string; value: string; fraction: number; warn: boolean }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const pct = Math.min(100, Math.max(0, Math.round(fraction * 100)));
  return (
    <View style={styles.meterBlock}>
      <View style={styles.meterHead}>
        <Text style={styles.meterLabel}>{label}</Text>
        <Text style={styles.meterValue}>{value}</Text>
      </View>
      <View
        style={styles.track}
        accessibilityRole="progressbar"
        accessibilityLabel={`${label}, ${value}`}
        accessibilityValue={{ min: 0, max: 100, now: pct }}
      >
        <View style={[styles.fill, { width: `${pct}%`, backgroundColor: warn ? colors.status.amberDot : colors.wire.ink }]} />
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  card: { borderWidth: 1, borderColor: colors.wire.line, borderRadius: 16, backgroundColor: colors.surfaceRaised, padding: 16 },
  eyebrow: { fontFamily: font.family.regular, fontSize: 14, color: colors.wire.sub },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 2 },
  plan: { fontFamily: font.family.semi, fontSize: 22, lineHeight: 28, color: colors.wire.ink },
  badge: { borderRadius: 999, paddingVertical: 2, paddingHorizontal: 9, backgroundColor: colors.status.amberBg },
  badgeText: { fontFamily: font.family.semi, fontSize: 12, lineHeight: 18, color: colors.status.amberText },
  unlimited: { fontFamily: font.family.regular, marginTop: 10, fontSize: 14, color: colors.wire.sub },
  bigRow: { flexDirection: "row", alignItems: "baseline", gap: 6, marginTop: 14 },
  big: {
    fontFamily: font.family.bold,
    fontSize: 30,
    letterSpacing: -0.5,
    color: colors.wire.ink,
    fontVariant: ["tabular-nums"],
  },
  bigLabel: { fontFamily: font.family.regular, fontSize: 14, color: colors.wire.mute },
  meterBlock: { marginTop: 14 },
  meterHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 8 },
  meterLabel: { fontFamily: font.family.medium, fontSize: 14, color: colors.wire.text },
  meterValue: { flexShrink: 1, fontFamily: font.family.regular, fontSize: 14, color: colors.wire.sub, fontVariant: ["tabular-nums"] },
  track: { height: 8, borderRadius: 999, backgroundColor: colors.wire.tint, overflow: "hidden" },
  fill: { height: "100%", borderRadius: 999 },
  facts: { marginTop: 12, gap: 2 },
  fact: { fontFamily: font.family.regular, fontSize: 13, color: colors.wire.mute },
});
