import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { openBilling } from "../../features/agents/billingLink";
import { font, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

export type InvoiceRow = {
  number: string;
  date: string | number;
  amountCents: number;
};

function formatDate(v: string | number): string {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function formatAmount(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function ExternalIcon({ color, strokeWidth }: { color: string; strokeWidth: number }) {
  return (
    <Svg width={14} height={14} viewBox="0 0 24 24">
      <Path
        d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}

export function InvoicesSection({
  invoices,
  isFree,
  canOpenReceipts,
}: {
  invoices: InvoiceRow[];
  isFree: boolean;
  canOpenReceipts: boolean;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <View>
      <View style={styles.table}>
        {}
        <View style={styles.head}>
          <Text style={[styles.headText, styles.grow]}>Invoice</Text>
          <Text style={[styles.headText, styles.dateCol]}>Date</Text>
          <Text style={[styles.headText, styles.amountCol]}>Amount</Text>
        </View>

        {}
        {invoices.length === 0 ? (
          <Text style={styles.empty}>
            {isFree ? "No invoices yet. Free plans are never billed." : "No invoices yet."}
          </Text>
        ) : (
          invoices.map((inv) => (
            <View key={inv.number} style={styles.row}>
              <Text style={[styles.rowNumber, styles.grow]}>{inv.number}</Text>
              <Text style={[styles.rowDate, styles.dateCol]}>{formatDate(inv.date)}</Text>
              <Text style={[styles.rowAmount, styles.amountCol]}>{formatAmount(inv.amountCents)}</Text>
            </View>
          ))
        )}

        {}
        {canOpenReceipts && !isFree ? (
          <Pressable
            accessibilityRole="link"
            onPress={openBilling}
            style={({ pressed }) => [styles.receipts, pressed && styles.pressed]}
          >
            <Text style={styles.receiptsText}>Download receipts on the web</Text>
            <ExternalIcon color={colors.wire.text} strokeWidth={2} />
          </Pressable>
        ) : null}
      </View>

      {}
      <View style={styles.note}>
        <View style={styles.noteIcon}>
          <ExternalIcon color={colors.wire.mute} strokeWidth={1.9} />
        </View>
        <Text style={styles.noteText}>
          The app takes no payment. Buttons that buy open zaviagent.com, and your balance here updates when you come
          back.
        </Text>
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  table: { borderWidth: 1, borderColor: colors.wire.line, borderRadius: 16, overflow: "hidden" },
  head: { flexDirection: "row", paddingVertical: 10, paddingHorizontal: 14, backgroundColor: colors.wire.head },
  headText: { fontFamily: font.family.medium, fontSize: 13, color: colors.wire.sub },
  grow: { flex: 1 },
  dateCol: { width: 92 },
  amountCol: { width: 64, textAlign: "right" },
  empty: {
    padding: 14,
    fontFamily: font.family.regular,
    fontSize: 14,
    color: colors.wire.mute,
    borderTopWidth: 1,
    borderTopColor: colors.wire.tint,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderTopWidth: 1,
    borderTopColor: colors.wire.tint,
  },
  rowNumber: { fontFamily: font.family.medium, fontSize: 14, color: colors.wire.text },
  rowDate: { fontFamily: font.family.regular, fontSize: 14, color: colors.wire.sub },
  rowAmount: { fontFamily: font.family.regular, fontSize: 14, color: colors.wire.text, fontVariant: ["tabular-nums"] },
  receipts: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderTopWidth: 1,
    borderTopColor: colors.wire.tint,
  },
  pressed: { backgroundColor: colors.wire.tint },
  receiptsText: { fontFamily: font.family.semi, fontSize: 14, color: colors.wire.text },
  note: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  noteIcon: { marginTop: 2 },
  noteText: { flex: 1, fontFamily: font.family.regular, fontSize: 13, lineHeight: 19, color: colors.wire.mute },
});
