import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { AppBottomSheet } from "../AppBottomSheet";
import { Icon } from "../Icon";
import { ZaviTextField } from "../ZaviTextField";
import { CardButton } from "../reply/ui";
import { showDialog } from "../DialogHost";
import { Note, ReadOnlyNote } from "./UgcParts";
import { money } from "../../features/channels/ugc";
import type { ThreadOffer } from "../../features/channels/ugc";
import {
  EMPTY_DRAFT,
  canWithdraw,
  checkOffer,
  digits,
  offerChip,
  offerDue,
  offerWhat,
  priceText,
  type OfferDraft,
} from "../../features/channels/ugcOffers";
import { offerCardActions, offerCardHint } from "../../features/channels/ugcHire";
import { useDeclineOffer } from "../../features/channels/ugcHireHooks";
import { useCanWrite, useSendOffer, useWithdrawOffer } from "../../features/channels/ugcHooks";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

const message = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

export function OfferCard({ offer, name, first }: { offer: ThreadOffer; name: string; first: string }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const router = useRouter();
  const withdraw = useWithdrawOffer();
  const decline = useDeclineOffer();
  const canWrite = useCanWrite();
  const [error, setError] = useState<string | null>(null);
  const mine = offer.proposed_by === "tenant";
  const chip = offerChip(offer, first);
  const hint = offerCardHint(offer, first);
  const act = offerCardActions(offer, first);
  const goPay = () => {
    if (act) router.push({ pathname: act.to.pathname as never, params: act.to.params });
  };

  function onDecline() {
    setError(null);
    decline.mutate(offer.id, { onError: (e) => setError(message(e, "Couldn't decline it. Try again.")) });
  }

  async function onWithdraw() {
    const ok = await showDialog({
      icon: "alertCircle",
      title: "Withdraw this offer?",
      message: `${first} will no longer be able to accept it. Nothing is charged.`,
      cancelLabel: "Keep it",
      confirmLabel: "Withdraw",
    });
    if (!ok) return;
    setError(null);
    withdraw.mutate(offer.id, { onError: (e) => setError(message(e, "Couldn't withdraw it. Try again.")) });
  }

  return (
    <View style={styles.offer}>
      <View style={styles.head}>
        <Icon name="file" size={15} color={colors.muted} />
        <Text style={styles.from} numberOfLines={1}>
          {mine ? `Your custom offer to ${name}` : `Custom offer from ${name}`}
        </Text>
        <Text style={[styles.chip, chip.tone === "amber" ? styles.chipAmber : chip.tone === "green" ? styles.chipGreen : styles.chipMuted]} numberOfLines={1}>
          {chip.label}
        </Text>
      </View>
      <Text style={styles.what}>{offerWhat(offer)}</Text>
      {offer.note ? <Text style={styles.note}>{offer.note}</Text> : null}
      <View style={styles.rows}>
        {(
          [
            ["Due", offerDue(offer)],
            ["Changes", "2 rounds of changes"],
            ["Price", money(offer.price_cents)],
          ] as Array<[string, string]>
        ).map(([k, v]) => (
          <View key={k} style={styles.row}>
            <Text style={styles.k}>{k}</Text>
            <Text style={styles.v}>{v}</Text>
          </View>
        ))}
        <View style={[styles.row, styles.total]}>
          <Text style={styles.kStrong}>You pay</Text>
          <Text style={styles.vStrong}>{money(offer.fees.business_total_cents)} with Zavi's 10% fee</Text>
        </View>
      </View>
      {hint ? <Text style={styles.note}>{hint}</Text> : null}
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
      {canWithdraw(offer) && canWrite ? (
        <View style={styles.actions}>
          <CardButton label="Withdraw" variant="secondary" onPress={() => void onWithdraw()} busy={withdraw.isPending} />
        </View>
      ) : act && !canWrite ? (
        <ReadOnlyNote />
      ) : act?.kind === "answer" ? (
        <View style={styles.actions}>
          <CardButton label={act.decline} variant="secondary" onPress={onDecline} busy={decline.isPending} />
          <CardButton label={act.accept} onPress={goPay} disabled={decline.isPending} />
        </View>
      ) : act?.kind === "pay" ? (
        <Note tone="ok" title={act.title}>
          <Text style={styles.payBody}>{act.body}</Text>
          <View style={styles.actions}>
            <CardButton label={act.label} onPress={goPay} />
          </View>
        </Note>
      ) : null}
    </View>
  );
}

export function SendOfferSheet({
  open,
  onClose,
  to,
  memberId,
  threadId,
}: {
  open: boolean;
  onClose: () => void;
  to: string;
  memberId: string;
  threadId: string | null;
}) {
  const styles = useStyles(makeStyles);
  const send = useSendOffer();
  const [draft, setDraft] = useState<OfferDraft>(EMPTY_DRAFT);
  const [error, setError] = useState<string | null>(null);
  const check = checkOffer(draft);
  const set = <K extends keyof OfferDraft>(k: K, v: OfferDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  function submit() {
    if (!check.body || send.isPending) return;
    setError(null);
    send.mutate(
      { memberId, threadId, body: check.body },
      {
        onSuccess: () => {
          setDraft(EMPTY_DRAFT);
          onClose();
        },
        onError: (e) => setError(message(e, "Couldn't send the offer. Try again.")),
      },
    );
  }

  const field = (label: string, value: string, onChange: (v: string) => void, placeholder: string, mode: "numeric" | "decimal-pad") => (
    <ZaviTextField
      title={label}
      inSheet
      multiline={false}
      value={value}
      onChangeText={onChange}
      keyboardType={mode}
      placeholder={placeholder}
      accessibilityLabel={label}
    />
  );

  return (
    <AppBottomSheet
      open={open}
      onClose={onClose}
      title="Send a custom offer"
      locked={send.isPending}
    >
      <View style={styles.form}>
        <Text style={styles.note}>{`${to} can accept or decline. You can withdraw it until they answer. Includes 2 rounds of changes.`}</Text>
        <View style={styles.two}>
          <View style={styles.half}>{field("How many videos", draft.count, (v) => set("count", digits(v)), "1", "numeric")}</View>
          <View style={styles.half}>{field("Price ($)", draft.price, (v) => set("price", priceText(v)), "150", "decimal-pad")}</View>
        </View>
        {field("Days to deliver", draft.days, (v) => set("days", digits(v)), "7", "numeric")}
        <View style={styles.field}>
          <Text style={styles.label}>{`Do you need to send ${to} a product?`}</Text>
          <View style={styles.pills}>
            {([false, true] as const).map((v) => (
              <Pressable
                key={String(v)}
                style={[styles.pill, draft.product === v && styles.pillOn]}
                onPress={() => set("product", v)}
                accessibilityRole="radio"
                accessibilityState={{ checked: draft.product === v }}
              >
                <Text style={[styles.pillText, draft.product === v && styles.pillTextOn]}>{v ? "Yes" : "No"}</Text>
              </Pressable>
            ))}
          </View>
          {draft.product ? <Text style={styles.note}>Share the delivery address in the job chat after hire. The due date starts when the creator marks Product received.</Text> : null}
        </View>
        {check.feeLine(to) ? <Text style={styles.fee}>{check.feeLine(to)}</Text> : null}
        {error ? (
          <Text style={styles.error} accessibilityRole="alert">
            {error}
          </Text>
        ) : null}
        <View style={styles.footer}>
          <CardButton label="Cancel" variant="secondary" onPress={onClose} disabled={send.isPending} />
          <CardButton label="Send offer" onPress={submit} disabled={!check.ready} busy={send.isPending} />
        </View>
      </View>
    </AppBottomSheet>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    offer: { gap: space.sm, padding: space.md, borderWidth: 1.5, borderColor: colors.ink, borderRadius: radius.lg, backgroundColor: colors.bg },
    head: { flexDirection: "row", alignItems: "center", gap: 6 },
    from: { flex: 1, fontFamily: font.family.semi, fontSize: 12, color: colors.muted },
    chip: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill, overflow: "hidden", fontFamily: font.family.semi, fontSize: 11 },
    chipAmber: { backgroundColor: colors.status.amberBg, color: colors.status.amberText },
    chipGreen: { backgroundColor: colors.status.greenBg, color: colors.status.greenText },
    chipMuted: { backgroundColor: colors.soft, color: colors.textSecondary },
    what: { fontFamily: font.family.semi, fontSize: 18, lineHeight: 24, color: colors.ink },
    note: { fontFamily: font.family.regular, fontSize: 12, lineHeight: 17, color: colors.muted },
    rows: { gap: 6 },
    row: { flexDirection: "row", justifyContent: "space-between", gap: space.md },
    total: { paddingTop: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
    k: { fontFamily: font.family.regular, fontSize: 13, color: colors.muted },
    v: { flexShrink: 1, textAlign: "right", fontFamily: font.family.medium, fontSize: 13, color: colors.ink },
    kStrong: { fontFamily: font.family.semi, fontSize: 13, color: colors.ink },
    vStrong: { flexShrink: 1, textAlign: "right", fontFamily: font.family.semi, fontSize: 13, color: colors.ink },
    actions: { flexDirection: "row", justifyContent: "flex-end", gap: space.sm },
    payBody: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.status.greenText },
    error: { fontFamily: font.family.medium, fontSize: 12, lineHeight: 17, color: colors.red },
    form: { gap: space.md },
    field: { gap: 4 },
    label: { fontFamily: font.family.semi, fontSize: 13, color: colors.ink },
    two: { flexDirection: "row", gap: space.md },
    half: { flex: 1 },
    pills: { flexDirection: "row", gap: space.sm },
    pill: { minHeight: 36, paddingHorizontal: 16, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.line, borderRadius: radius.pill },
    pillOn: { backgroundColor: colors.ink, borderColor: colors.ink },
    pillText: { fontFamily: font.family.medium, fontSize: 14, color: colors.ink },
    pillTextOn: { color: colors.onInk },
    fee: { fontFamily: font.family.medium, fontSize: 13, lineHeight: 18, color: colors.textSecondary },
    footer: { flexDirection: "row", justifyContent: "flex-end", gap: space.sm, marginTop: space.sm },
  });
