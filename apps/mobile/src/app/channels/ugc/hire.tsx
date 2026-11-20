import { useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { KeyboardAvoider } from "../../../components/KeyboardAvoider";
import { SkeletonBlock } from "../../../components/Skeleton";
import { FocusRing } from "../../../components/ZaviTextField";
import { CreatorPhoto, LoadError, TickRow, YesNo } from "../../../components/channels/UgcHireParts";
import { ErrorText, KeyValue, Note, ReadOnlyNote, StateLine, UgcButton, UgcScreen } from "../../../components/channels/UgcParts";
import { CHECKOUT_RETURN_HINT, openCheckout } from "../../../features/channels/ugcCheckout";
import {
  NO_CHECKOUT,
  PAY_BUSY,
  SHOW_MAX,
  blockOf,
  hireLoadingTitle,
  hireMode,
  hireTitle,
  jobCard,
  largeConfirm,
  modeCard,
  moneyOf,
  payLabel,
  payRequest,
  priceMoved,
  priceMovedNote,
  quoteBody,
  readPayAnswer,
  shieldNote,
  summaryRows,
  applicationAnswered,
  whoOf,
  type HireContext,
  type HireMode,
  type HireParams,
  type Money3,
  type PayAnswer,
  withPaymentFlags,
} from "../../../features/channels/ugcHire";
import { useBriefApplicants, useOffer, usePayCheckout, usePendingHires, useQuote, useRememberHire } from "../../../features/channels/ugcHireHooks";
import { useBriefWorkbench, useCanWrite, useCreatorCard, useJobDetail, useThreadOffers } from "../../../features/channels/ugcHooks";
import { useActiveTenant } from "../../../features/workspaces/useActiveTenant";
import { CHANNELS_ENABLED } from "../../../lib/flags";
import { font, radius, space, type Colors } from "../../../theme/tokens";
import { useStyles, useTheme } from "../../../theme/theme";

const WORKSPACE_SWITCHED = "You switched workspace. Open this again from the workspace that should pay.";
const one = (v: string | string[] | undefined) => (typeof v === "string" && v ? v : undefined);
const message = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

export default function CheckoutRoute() {
  if (!CHANNELS_ENABLED) return <Redirect href="/chat" />;
  return <Checkout />;
}

function Checkout() {
  const raw = useLocalSearchParams<{ package?: string; application?: string; brief?: string; offer?: string }>();
  const params: HireParams = { package: one(raw.package), application: one(raw.application), brief: one(raw.brief), offer: one(raw.offer) };
  const mode = hireMode(params);
  if (!mode) {
    return (
      <UgcScreen title={hireLoadingTitle}>
        <StateLine empty="This link does not say what to pay for. Open it again from the brief, the creator or the offer." />
      </UgcScreen>
    );
  }
  return <Door key={`${mode}:${params.package ?? params.application ?? params.offer}`} mode={mode} params={params} />;
}

type Pending = { orderId: string | null; url: string | null; money: Money3 };

function Door({ mode, params }: { mode: HireMode; params: HireParams }) {
  const styles = useStyles(makeStyles);
  const { colors, keyboardAppearance, textSelectionColor } = useTheme();
  const router = useRouter();
  const tenant = useActiveTenant();
  const canWrite = useCanWrite();
  const pay = usePayCheckout();
  const remember = useRememberHire();
  const pendingHires = usePendingHires();
  const homeTenant = useRef<string | null>(null);
  if (homeTenant.current === null && tenant !== "none") homeTenant.current = tenant;
  const switched = homeTenant.current !== null && tenant !== homeTenant.current;

  const [product, setProduct] = useState(false);
  const [show, setShow] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const inFlight = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const quote = useQuote(mode !== "offer" && canWrite ? quoteBody(mode, params, product) : null);
  const offer = useOffer(mode === "offer" ? (params.offer ?? "") : "");
  const briefId = mode === "application" ? (params.brief ?? quote.data?.job.brief_id ?? "") : "";
  const applicants = useBriefApplicants(briefId);
  const bench = useBriefWorkbench(briefId || null);
  const memberId = quote.data?.creator.human_member_id ?? offer.data?.human_member_id ?? "";
  const card = useCreatorCard(memberId);

  const listed = useThreadOffers(mode === "offer" && offer.data?.status === "accepted" ? (offer.data.thread_id ?? null) : null);
  const offerView = offer.data ? withPaymentFlags(offer.data, listed.data as never) : null;

  const ctx: HireContext = {
    mode,
    quote: quote.data ?? null,
    offer: offerView,
    card: card.data ?? null,
    bench: bench.data?.brief ?? null,
    packageId: params.package,
  };
  const applicant = applicants.data?.applicants.find((a) => a.application_id === params.application);
  const answered = mode === "application" && applicant && !pending ? applicationAnswered(applicant) : null;
  const storedOrder = answered && params.application ? (pendingHires.data?.[params.application] ?? null) : null;
  const stored = useJobDetail(storedOrder ?? "");
  const resumeOrder = storedOrder && stored.data?.job.status === "checkout_pending" ? storedOrder : null;
  const source = mode === "offer" ? offer : quote;
  const ready = mode === "offer" ? !!offer.data : !!quote.data;

  if (!ready) {
    return (
      <UgcScreen title={hireLoadingTitle}>
        {mode !== "offer" && !canWrite ? (
          <View style={styles.content}>
            <ReadOnlyNote />
          </View>
        ) : source.isError ? (
          <LoadError message={message(source.error, "Couldn't load this.")} onRetry={() => void source.refetch()} />
        ) : (
          <HireSkeleton />
        )}
      </UgcScreen>
    );
  }

  const money = pending?.money ?? moneyOf(ctx);
  const job = jobCard(ctx);
  const extra = modeCard(ctx, applicant?.note ?? null);
  const block = switched ? WORKSPACE_SWITCHED : (answered ?? blockOf(ctx));
  const large = largeConfirm(ctx, money);
  const repricing = mode !== "offer" && (quote.isFetching || quote.isPlaceholderData);
  const off = !canWrite || busy || !!block || (!!large && !confirmed) || repricing || !money;

  const changePackage = (f: () => void) => {
    f();
    if (mode === "package") setPending(null);
  };

  async function onPay() {
    if (inFlight.current || off || !money) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const startedIn = tenant;
    try {
      let answer: PayAnswer;
      if (pending && pending.money.business_total_cents === money.business_total_cents) {
        answer = pending;
      } else {
        const req = payRequest(ctx, params, { confirmed, show, product });
        if (!req) {
          setError(NO_CHECKOUT);
          return;
        }
        answer = readPayAnswer(mode, await pay.mutateAsync(req));
        if (mode === "application" && params.application && answer.orderId) await remember(startedIn, params.application, answer.orderId);
        if (answer.money && priceMoved(money.business_total_cents, answer.money)) {
          setPending({ orderId: answer.orderId, url: answer.url, money: answer.money });
          return;
        }
      }
      if (!answer.url) {
        if (answer.orderId) {
          if (alive.current) router.replace({ pathname: "/channels/ugc/job/[id]", params: { id: answer.orderId } });
          return;
        }
        setError(NO_CHECKOUT);
        return;
      }
      if (!alive.current) return;
      await openCheckout(answer.url);
      if (answer.orderId) router.replace({ pathname: "/channels/ugc/job/[id]", params: { id: answer.orderId } });
      else router.back();
    } catch (e) {
      if ((e as { code?: unknown } | null)?.code === "large_amount_confirm_required") void quote.refetch();
      setError(message(e, "Couldn't open the payment page. Try again."));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <UgcScreen title={hireTitle(ctx)}>
      <KeyboardAvoider style={styles.fill}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.card}>
            <View style={styles.jobRow}>
              <CreatorPhoto name={whoOf(ctx).name} url={card.data?.photo_url ?? null} />
              <View style={styles.jobText}>
                <Text style={styles.title}>{job.title}</Text>
                {job.terms ? <Text style={styles.body}>{job.terms}</Text> : null}
                <Text style={styles.sub}>{job.who}</Text>
              </View>
            </View>
          </View>

          {extra.kind === "application" ? (
            <View style={styles.card}>
              <Text style={styles.label}>{extra.noteTitle}</Text>
              {}
              {applicants.data ? <Text style={styles.body}>{extra.note}</Text> : null}
              <Text style={[styles.label, styles.gapTop]}>Product to send</Text>
              <Text style={styles.body}>{extra.product}</Text>
            </View>
          ) : extra.kind === "offer" ? (
            <View style={styles.card}>
              <Text style={styles.label}>{extra.heading}</Text>
              <Text style={styles.body}>{extra.terms}</Text>
              <Text style={[styles.label, styles.gapTop]}>Product to send</Text>
              <Text style={styles.body}>{extra.product}</Text>
            </View>
          ) : (
            <View style={styles.card}>
              <Text style={styles.fieldLabel}>{extra.showLabel}</Text>
              <FocusRing radius={radius.sm}>
                {(focus) => (
                  <TextInput
                    value={show}
                    onChangeText={(t) => changePackage(() => setShow(t.slice(0, SHOW_MAX)))}
                    maxLength={SHOW_MAX}
                    multiline
                    editable={canWrite && !busy}
                    textAlignVertical="top"
                    placeholderTextColor={colors.muted}
                    keyboardAppearance={keyboardAppearance}
                    selectionColor={textSelectionColor}
                    cursorColor={colors.ink}
                    selectionHandleColor={colors.ink}
                    accessibilityLabel={extra.showLabel}
                    onFocus={focus.onFocus}
                    onBlur={focus.onBlur}
                    style={styles.input}
                  />
                )}
              </FocusRing>
              <Text style={[styles.label, styles.gapTop]}>{extra.productQuestion}</Text>
              <YesNo value={product} onChange={(v) => changePackage(() => setProduct(v))} label={extra.productQuestion} disabled={!canWrite || busy} />
              {product ? <Text style={styles.sub}>{extra.productYesNote}</Text> : null}
            </View>
          )}

          <View style={styles.card}>
            <Text style={styles.label}>Summary</Text>
            {money ? summaryRows(ctx, money, product).map((r) => <KeyValue key={r.label} label={r.label} value={r.value} strong={r.strong} />) : null}
            <Note>{shieldNote(ctx)}</Note>
            {mode === "offer" && listed.isError && offerView?.awaiting_payment === undefined ? (
              <LoadError message="Couldn't check whether this offer is paid." onRetry={() => void listed.refetch()} />
            ) : block ? (
              <Note tone="bad">{block}</Note>
            ) : null}
            {resumeOrder && canWrite ? (
              <UgcButton label="Finish paying" onPress={() => router.replace({ pathname: "/channels/ugc/job/[id]", params: { id: resumeOrder } })} />
            ) : null}
            {large ? <TickRow checked={confirmed} onChange={(v) => changePackage(() => setConfirmed(v))} label={large} disabled={!canWrite || busy} /> : null}
            {}
            {pending ? <Note tone="warn">{priceMovedNote(pending.money.business_total_cents)}</Note> : null}
            <ErrorText>{error}</ErrorText>
            {canWrite ? (
              <UgcButton
                label={repricing && !busy ? "Updating price…" : payLabel(mode, money)}
                busy={busy}
                busyLabel={PAY_BUSY}
                disabled={off}
                onPress={() => void onPay()}
              />
            ) : (
              <ReadOnlyNote />
            )}
            {canWrite ? <Text style={styles.hint}>{CHECKOUT_RETURN_HINT}</Text> : null}
          </View>
        </ScrollView>
      </KeyboardAvoider>
    </UgcScreen>
  );
}

function HireSkeleton() {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.content} accessible accessibilityLabel="Loading checkout" accessibilityState={{ busy: true }}>
      <View style={[styles.card, styles.jobRow]}>
        <SkeletonBlock width={40} height={40} radius={20} />
        <View style={styles.jobText}>
          <SkeletonBlock width="75%" height={18} />
          <SkeletonBlock width="50%" height={13} />
        </View>
      </View>
      <View style={styles.card}>
        <SkeletonBlock width="45%" height={16} />
        <SkeletonBlock height={84} radius={radius.sm} />
      </View>
      <View style={styles.card}>
        <SkeletonBlock width="30%" height={16} />
        {[0, 1, 2].map((i) => (
          <SkeletonBlock key={i} height={14} />
        ))}
        <SkeletonBlock height={44} radius={radius.sm} style={styles.gapTop} />
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    fill: { flex: 1 },
    content: { paddingHorizontal: space.lg, paddingTop: 20, paddingBottom: 20, gap: space.md },
    card: { gap: space.sm, padding: space.md, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md },
    jobRow: { flexDirection: "row", alignItems: "flex-start", gap: space.md },
    jobText: { flex: 1, minWidth: 0, gap: 4 },
    title: { fontFamily: font.family.semi, fontSize: 16, lineHeight: 22, color: colors.ink },
    label: { fontFamily: font.family.semi, fontSize: 14, lineHeight: 20, color: colors.ink },
    fieldLabel: { fontFamily: font.family.medium, fontSize: 14, lineHeight: 20, color: colors.ink },
    gapTop: { marginTop: space.sm },
    body: { fontFamily: font.family.regular, fontSize: 14, lineHeight: 21, color: colors.textSecondary },
    sub: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.muted },
    hint: { fontFamily: font.family.regular, fontSize: 12, lineHeight: 17, color: colors.muted, textAlign: "center" },
    input: {
      minHeight: 84,
      paddingHorizontal: space.md,
      paddingVertical: 10,
      fontFamily: font.family.medium,
      fontSize: 15,
      lineHeight: 20,
      color: colors.ink,
    },
  });
