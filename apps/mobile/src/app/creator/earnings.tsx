import { useState } from "react";
import { Linking, StyleSheet, Text, View } from "react-native";
import {
  Card,
  CreatorScreen,
  Empty,
  ErrorNote,
  Loading,
  PrimaryButton,
  SecondaryButton,
  SectionTitle,
} from "../../components/creator/CreatorChrome";
import { useCreatorEarnings } from "../../features/creator/hooks";
import { CreatorApiError, creatorApi, money, statusWords } from "../../features/creator/api";
import { font, space, type Colors } from "../../theme/tokens";
import { useStyles } from "../../theme/theme";

const BUCKET_WORDS: Record<"held" | "on_the_way" | "paid", string> = {
  held: "Held",
  on_the_way: "On the way",
  paid: "Paid",
};

function Total({ label, cents, note }: { label: string; cents: number; note: string }) {
  const styles = useStyles(makeStyles);
  return (
    <Card>
      <SectionTitle>{label}</SectionTitle>
      <Text style={styles.total}>{money(cents)}</Text>
      <Text style={styles.hint}>{note}</Text>
    </Card>
  );
}

export default function CreatorEarningsScreen() {
  const styles = useStyles(makeStyles);
  const { data, isPending, error } = useCreatorEarnings();
  const [busy, setBusy] = useState<"onboard" | "tax" | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);

  const openStripe = async (kind: "onboard" | "tax") => {
    setBusy(kind);
    setLinkError(null);
    try {
      const { url } =
        kind === "onboard" ? await creatorApi.onboardingLink() : await creatorApi.taxFormsLink();
      const opened = await Linking.canOpenURL(url);
      if (!opened) throw new Error("no browser");
      await Linking.openURL(url);
    } catch (e) {
      setLinkError(e instanceof CreatorApiError ? e.message : "Stripe did not open. Try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <CreatorScreen title="Earnings">
      {error ? (
        <ErrorNote
          message={
            error instanceof CreatorApiError ? error.message : "Your earnings did not load."
          }
        />
      ) : isPending || !data ? (
        <Loading what="your earnings" />
      ) : (
        <>
          <ErrorNote message={linkError} />

          <Total
            label="Held"
            cents={data.held_cents}
            note="Zavi has this. It moves when the business approves, or automatically if they do not."
          />
          <Total
            label="On the way"
            cents={data.on_the_way_cents}
            note="Released and heading to your bank through Stripe."
          />
          <Total label="Paid" cents={data.paid_cents} note="Already sent to your bank." />

          <Card>
            <Text style={styles.h2}>Getting paid</Text>
            {data.payout_country_supported === false ? (
              <Text style={styles.hint}>
                Zavi cannot pay creators in your country yet, so there is nothing to set up. We will
                email you when that changes.
              </Text>
            ) : !data.payout.connected || !data.payout.details_submitted ? (
              <>
                <Text style={styles.hint}>
                  Stripe handles your bank details and your tax forms. Zavi never sees them. You
                  only need this before your first payment goes out.
                </Text>
                <PrimaryButton
                  label={busy === "onboard" ? "Opening Stripe" : "Set up payouts with Stripe"}
                  disabled={busy !== null}
                  onPress={() => void openStripe("onboard")}
                />
                <Text style={styles.hint}>Opens in your browser.</Text>
              </>
            ) : (
              <>
                <Text style={styles.hint}>
                  {data.payout.payouts_enabled
                    ? "Payouts are on. Stripe sends money to the bank account you gave them."
                    : "Stripe has your details and is still checking them. Payments wait until they are done."}
                </Text>
                <SecondaryButton
                  label={busy === "tax" ? "Opening Stripe" : "Tax forms"}
                  disabled={busy !== null}
                  onPress={() => void openStripe("tax")}
                />
                <Text style={styles.hint}>
                  Opens your Stripe account in your browser, where your tax forms live.
                </Text>
              </>
            )}
          </Card>

          <SectionTitle>Per job</SectionTitle>
          {data.lines.length === 0 ? (
            <Empty>Nothing yet. Every job you accept shows up here.</Empty>
          ) : (
            data.lines.map((l) => (
              <Card key={l.order_id}>
                <View style={styles.lineHead}>
                  <Text style={styles.lineTitle}>{l.title ?? "A job"}</Text>
                  <Text style={styles.lineAmount}>{money(l.amount_cents)}</Text>
                </View>
                <Text style={styles.hint}>
                  {BUCKET_WORDS[l.bucket]}, {statusWords(l.status)}
                </Text>
                <Text style={styles.hint}>
                  Your price {money(l.price_cents)}, Zavi fee {money(l.creator_fee_cents)}
                  {l.part_paid ? ", part payment after Zavi stepped in" : ""}
                </Text>
              </Card>
            ))
          )}
        </>
      )}
    </CreatorScreen>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  h2: { fontSize: font.size.base, fontWeight: "700", color: colors.ink },
  total: { fontSize: font.size.title, fontWeight: "700", color: colors.ink },
  hint: { fontSize: font.size.sm, lineHeight: 18, color: colors.muted },
  lineHead: { flexDirection: "row", justifyContent: "space-between", gap: space.md },
  lineTitle: { fontSize: font.size.base, fontWeight: "700", color: colors.ink, flexShrink: 1 },
  lineAmount: { fontSize: font.size.base, fontWeight: "700", color: colors.ink },
});
