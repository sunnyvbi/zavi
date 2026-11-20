import { useCallback, useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View, type TextInputProps } from "react-native";
import { Redirect, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { AD_RIGHTS_DAYS, CREATOR_NICHES, MAX_PRICE_CENTS, creatorFeeBreakdown } from "@zavi/shared";
import { KeyboardAvoider } from "../../../../components/KeyboardAvoider";
import { FocusRing } from "../../../../components/ZaviTextField";
import { useSuccessToast } from "../../../../components/channels/ChannelToast";
import { showDialog } from "../../../../components/DialogHost";
import { Chip, ReadOnlyNote, StateLine, UgcButton, UgcScreen } from "../../../../components/channels/UgcParts";
import { money } from "../../../../features/channels/ugc";
import { setPendingToast, takePendingToast } from "../../../../features/channels/pendingToast";
import { check, dayFromNow, digits, draftFrom, PLATFORMS, toInput, type Draft } from "../../../../features/channels/ugcBrief";
import { REPOST_DIALOG, applicantsRoute, seeApplicantsLabel } from "../../../../features/channels/ugcHire";
import { useBriefWorkbench, useCanWrite, usePublishBrief, useRepostBrief, useSaveBrief } from "../../../../features/channels/ugcHooks";
import { CHANNELS_ENABLED } from "../../../../lib/flags";
import { font, radius, space, type Colors } from "../../../../theme/tokens";
import { useStyles, useTheme } from "../../../../theme/theme";

export default function BriefRoute() {
  if (!CHANNELS_ENABLED) return <Redirect href="/chat" />;
  return <Brief />;
}

function Brief() {
  const { id = "new" } = useLocalSearchParams<{ id?: string }>();
  const briefId = id === "new" ? null : id;
  const q = useBriefWorkbench(briefId);
  const posted = Boolean(q.data?.brief.posted_at);
  const title = posted ? `${q.data?.brief.title ?? "Brief"}, published` : "Post a brief to Zavi creators";
  const { show, toast } = useSuccessToast();

  useFocusEffect(
    useCallback(() => {
      const m = takePendingToast();
      if (m) show(m);
    }, [show]),
  );

  return (
    <UgcScreen title={title}>
      {briefId && !q.data ? (
        <StateLine loading={q.isLoading} error={q.isError} onRetry={() => void q.refetch()} />
      ) : posted && q.data ? (
        <PublishedBrief bench={q.data} />
      ) : (
        <BriefEditor key={briefId ?? "new"} briefId={briefId} bench={q.data ?? null} onSaved={show} />
      )}
      {toast}
    </UgcScreen>
  );
}

function PublishedBrief({ bench }: { bench: NonNullable<ReturnType<typeof useBriefWorkbench>["data"]> }) {
  const styles = useStyles(makeStyles);
  const router = useRouter();
  const repost = useRepostBrief();
  const canWrite = useCanWrite();
  const [error, setError] = useState<string | null>(null);
  const b = bench.brief;
  const applicants = applicantsRoute(b.id);

  async function onRepost() {
    if (repost.isPending) return;
    const ok = await showDialog({ ...REPOST_DIALOG });
    if (!ok) return;
    setError(null);
    repost.mutate(b.id, {
      onSuccess: (id) => {
        setPendingToast("Closed. Here is an editable copy to repost.");
        router.replace({ pathname: "/channels/ugc/brief/[id]", params: { id } });
      },
      onError: (e) => setError(e instanceof Error && e.message ? e.message : "Couldn't repost. Try again."),
    });
  }

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <Text style={styles.sub}>Published. A published brief can't be edited; to change it, close it and repost.</Text>
        <Text style={styles.previewTitle}>{b.title}</Text>
        <Text style={styles.body}>{b.angle}</Text>
        <Text style={styles.body}>
          <Text style={styles.strong}>Hook: </Text>
          {b.hook}
        </Text>
        <Text style={styles.body}>
          <Text style={styles.strong}>Format: </Text>
          {b.format}
        </Text>
        {error ? (
          <Text style={styles.error} accessibilityRole="alert">
            {error}
          </Text>
        ) : null}
      </View>
      <UgcButton
        label={seeApplicantsLabel(bench.applicant_count)}
        onPress={() => router.push({ pathname: applicants.pathname as never, params: applicants.params })}
      />
      {!b.closed_at ? (
        canWrite ? (
          <UgcButton label="Close and repost" variant="secondary" busy={repost.isPending} busyLabel="Reposting" onPress={() => void onRepost()} />
        ) : (
          <ReadOnlyNote />
        )
      ) : null}
    </ScrollView>
  );
}

function BriefEditor({
  briefId,
  bench,
  onSaved,
}: {
  briefId: string | null;
  bench: ReturnType<typeof useBriefWorkbench>["data"] | null;
  onSaved: (message: string) => void;
}) {
  const styles = useStyles(makeStyles);
  const router = useRouter();
  const save = useSaveBrief();
  const publish = usePublishBrief();
  const canWrite = useCanWrite();
  const [d, setD] = useState<Draft>(() => draftFrom(bench?.brief ?? null));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const busy = save.isPending || publish.isPending;

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setSaved(false);
    setConfirming(false);
    setD((x) => ({ ...x, [k]: v }));
  };
  const flip = (k: "platforms" | "niches", v: string) => set(k, d[k].includes(v) ? d[k].filter((x) => x !== v) : [...d[k], v]);

  const c = check(d);
  const budgetN = Number(d.budget) || 0;
  const fees = (() => {
    const cents = budgetN * 100;
    if (!Number.isInteger(cents) || cents <= 0 || cents > MAX_PRICE_CENTS) return null;
    try {
      return creatorFeeBreakdown(cents);
    } catch {
      return null;
    }
  })();
  const business = bench?.creator_preview.business_name ?? "";

  async function persist(): Promise<string | null> {
    try {
      return await save.mutateAsync({ id: briefId, input: toInput(d) });
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Couldn't save. Try again.");
      return null;
    }
  }

  async function onSave() {
    setError(null);
    const id = await persist();
    if (!id) return;
    setSaved(true);
    if (id !== briefId) {
      setPendingToast("Draft saved.");
      router.replace({ pathname: "/channels/ugc/brief/[id]", params: { id } });
    } else onSaved("Draft saved.");
  }

  async function onPublish() {
    setError(null);
    const id = await persist();
    if (!id) {
      setConfirming(false);
      return;
    }
    try {
      await publish.mutateAsync(id);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Couldn't publish. Your draft is saved.");
      setConfirming(false);
      if (id !== briefId) router.replace({ pathname: "/channels/ugc/brief/[id]", params: { id } });
      return;
    }
    setPendingToast("Brief published. Creators can apply now.");
    router.back();
  }

  return (
    <KeyboardAvoider style={styles.body1}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.sub}>You can change anything while it is a draft. Once you publish, the brief can't be edited.</Text>
        <View style={styles.card}>
          <Text style={styles.caps}>
            {bench?.brief.rationale && !/^Written by hand/.test(bench.brief.rationale) ? "Drafted by Zavi, change anything" : "Your draft, change anything"}
          </Text>
          <Text style={styles.h1}>Draft brief</Text>

          <Section title="The video">
            <Field label="Title">
              <Input value={d.title} onChangeText={(v) => set("title", v)} placeholder="What the video is for" />
            </Field>
            <Field label="Angle" hint="what the video is about">
              <Input value={d.angle} onChangeText={(v) => set("angle", v)} multiline />
            </Field>
            <Field label="Hook" hint="the first seconds">
              <Input value={d.hook} onChangeText={(v) => set("hook", v)} multiline />
            </Field>
            <Field label="Format">
              <Input value={d.format} onChangeText={(v) => set("format", v)} placeholder="For example, vertical video, 30 seconds" />
            </Field>
            <Field label="How many videos" hint="1 to 20" error={!c.videosOk}>
              <Input value={d.deliverables} onChangeText={(v) => set("deliverables", digits(v))} keyboardType="number-pad" />
            </Field>
            <View style={styles.switchRow}>
              <View style={styles.switchText}>
                <Text style={styles.label}>Do you need to send the creator a product?</Text>
                {d.product ? (
                  <Text style={styles.sub}>Share the delivery address in the job chat after hire. The due date starts when the creator marks Product received.</Text>
                ) : null}
              </View>
              <Switch value={d.product} onValueChange={(v) => set("product", v)} accessibilityLabel="Send the creator a product" />
            </View>
          </Section>

          <Section title="Where it runs">
            <Text style={styles.label}>Ad rights</Text>
            <Text style={styles.sub}>How long you may run the video in your ads</Text>
            <View style={styles.chips}>
              {AD_RIGHTS_DAYS.map((n) => (
                <Toggle key={n} label={`${n} days`} on={d.rights === String(n)} onPress={() => set("rights", String(n))} />
              ))}
            </View>
            <Text style={styles.label}>Platforms</Text>
            <View style={styles.chips}>
              {PLATFORMS.map((p) => (
                <Toggle key={p} label={p} on={d.platforms.includes(p)} onPress={() => flip("platforms", p)} />
              ))}
            </View>
          </Section>

          <Section title="Money and time">
            <Field label="Budget per video (USD)" hint="creators set their own price">
              <Input value={d.budget} onChangeText={(v) => set("budget", digits(v))} keyboardType="number-pad" />
            </Field>
            <Field label="Days to deliver" hint="1 to 90, after you hire" error={!c.daysOk}>
              <Input value={d.days} onChangeText={(v) => set("days", digits(v))} keyboardType="number-pad" />
            </Field>
            <Field label="Answer everyone by" hint="YYYY-MM-DD" error={!c.dayOk}>
              <Input value={d.answerBy} onChangeText={(v) => set("answerBy", v.replace(/[^\d-]/g, "").slice(0, 10))} keyboardType="numbers-and-punctuation" placeholder="2026-10-12" />
            </Field>
            <View style={styles.chips}>
              {[3, 7, 14].map((n) => (
                <Toggle key={n} label={`In ${n} days`} on={d.answerBy === dayFromNow(n)} onPress={() => set("answerBy", dayFromNow(n))} />
              ))}
              {d.answerBy ? <Toggle label="No date" on={false} onPress={() => set("answerBy", "")} /> : null}
            </View>
          </Section>

          <Section title="Who can apply">
            <Text style={styles.label}>Niches</Text>
            <View style={styles.chips}>
              {}
              {[...CREATOR_NICHES, ...d.niches.filter((n) => !(CREATOR_NICHES as readonly string[]).includes(n))].map((n) => (
                <Toggle key={n} label={n} on={d.niches.includes(n)} onPress={() => flip("niches", n)} />
              ))}
            </View>
            <Field label="Locations" hint="cities or regions, comma separated">
              <Input value={d.locations} onChangeText={(v) => set("locations", v)} placeholder="Leave empty for anywhere" />
            </Field>
            <Field label="Application limit" hint="1 to 500" error={!c.capOk}>
              <Input value={d.cap} onChangeText={(v) => set("cap", digits(v))} keyboardType="number-pad" />
            </Field>
            <Field label="Note to people you don't hire" hint="sent once your payment goes through">
              <Input value={d.note} onChangeText={(v) => set("note", v)} multiline />
            </Field>
          </Section>

          {error ? (
            <Text style={styles.error} accessibilityRole="alert">
              {error}
            </Text>
          ) : null}
          {!canWrite ? (
            <ReadOnlyNote />
          ) : confirming ? (
            <View style={styles.confirm}>
              <Text style={styles.confirmText}>Publish for good? You can't edit it after.</Text>
              <View style={styles.row}>
                <Pressable style={[styles.secondary, busy && styles.disabled]} disabled={busy} onPress={() => setConfirming(false)} accessibilityRole="button">
                  <Text style={styles.secondaryText}>Not yet</Text>
                </Pressable>
                <Pressable style={[styles.primary, (busy || !c.ready) && styles.disabled]} disabled={busy || !c.ready} onPress={() => void onPublish()} accessibilityRole="button">
                  <Text style={styles.primaryText}>{publish.isPending ? "Publishing" : "Yes, publish"}</Text>
                </Pressable>
              </View>
            </View>
          ) : (
            <View style={styles.confirm}>
              {!c.ready ? <Text style={styles.sub}>To publish: title, angle, hook and format.</Text> : null}
              {c.ready && saved ? <Text style={styles.saved}>Draft saved.</Text> : null}
              <View style={styles.row}>
                <Pressable style={[styles.secondary, (busy || !c.ready) && styles.disabled]} disabled={busy || !c.ready} onPress={() => void onSave()} accessibilityRole="button">
                  <Text style={styles.secondaryText}>{save.isPending ? "Saving" : "Save draft"}</Text>
                </Pressable>
                <Pressable style={[styles.primary, (busy || !c.ready) && styles.disabled]} disabled={busy || !c.ready} onPress={() => setConfirming(true)} accessibilityRole="button">
                  <Text style={styles.primaryText}>Publish</Text>
                </Pressable>
              </View>
            </View>
          )}
        </View>

        <Text style={styles.caps}>What creators see</Text>
        <View style={styles.card}>
          {business ? <Text style={styles.sub}>{business}</Text> : null}
          <Text style={styles.previewTitle}>{d.title || "Your title"}</Text>
          <Text style={styles.body}>{d.angle || "Your angle shows here."}</Text>
          <Text style={styles.body}>
            <Text style={styles.strong}>Hook: </Text>
            {d.hook || "Not set"}
          </Text>
          <Text style={styles.body}>
            <Text style={styles.strong}>Format: </Text>
            {d.format || "Not set"} · {d.deliverables || "1"} {Number(d.deliverables) === 1 ? "video" : "videos"}
          </Text>
          <Text style={styles.sub}>UGC video: you post it and run it as an ad</Text>
          {d.rights ? <Text style={styles.sub}>Ad rights for {d.rights} days</Text> : null}
          <View style={styles.chips}>
            {[...d.platforms, ...d.niches].map((t) => (
              <Chip key={t} label={t} />
            ))}
          </View>
          {(
            [
              ["Budget", budgetN ? money(budgetN * 100) : "Not set"],
              ["Deliver in", d.days ? `${d.days} days` : "Not set"],
              ["Where", d.locations || "Anywhere"],
              ["Answer by", c.dayOk && d.answerBy ? new Date(`${d.answerBy}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "Not set"],
            ] as const
          ).map(([k, v]) => (
            <View key={k} style={styles.kv}>
              <Text style={styles.sub}>{k}</Text>
              <Text style={styles.strong}>{v}</Text>
            </View>
          ))}
          {fees ? (
            <Text style={styles.feeNote}>
              At {money(fees.price_cents)} you receive {money(fees.creator_payout_cents)} after Zavi's 15%.
            </Text>
          ) : null}
          {d.cap ? <Text style={styles.sub}>Up to {d.cap} applications</Text> : null}
        </View>
      </ScrollView>
    </KeyboardAvoider>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.section}>
      <Text style={styles.h2}>{title}</Text>
      {children}
    </View>
  );
}

function Field({ label, hint, error = false, children }: { label: string; hint?: string; error?: boolean; children: ReactNode }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>
        {label}
        {hint ? <Text style={styles.sub}>{`  ${hint}`}</Text> : null}
      </Text>
      {children}
      {error ? <Text style={styles.error}>Check this one.</Text> : null}
    </View>
  );
}

function Input(props: TextInputProps) {
  const styles = useStyles(makeStyles);
  const { colors, textSelectionColor } = useTheme();
  return (
    <FocusRing radius={radius.sm}>
      {(focus) => (
        <TextInput
          placeholderTextColor={colors.muted}
          {...props}
          selectionColor={textSelectionColor}
          cursorColor={colors.ink}
          selectionHandleColor={colors.ink}
          onFocus={(e) => {
            focus.onFocus();
            props.onFocus?.(e);
          }}
          onBlur={(e) => {
            focus.onBlur();
            props.onBlur?.(e);
          }}
          style={[styles.input, props.multiline && styles.inputMulti]}
          textAlignVertical={props.multiline ? "top" : "center"}
        />
      )}
    </FocusRing>
  );
}

function Toggle({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  const styles = useStyles(makeStyles);
  return (
    <Pressable
      style={[styles.toggle, on && styles.toggleOn]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
    >
      <Text style={[styles.toggleText, on && styles.toggleTextOn]}>{label}</Text>
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    body1: { flex: 1 },
    content: { paddingHorizontal: space.lg, paddingTop: 20, paddingBottom: 20, gap: space.md },
    card: { gap: space.sm, padding: space.md, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md },
    caps: { fontFamily: font.family.semi, fontSize: 10, letterSpacing: 1, textTransform: "uppercase", color: colors.muted },
    h1: { fontFamily: font.family.semi, fontSize: 22, letterSpacing: -0.3, color: colors.ink },
    h2: { fontFamily: font.family.semi, fontSize: 16, color: colors.ink },
    section: { gap: space.sm, marginTop: space.md, paddingTop: space.md, borderTopWidth: 1, borderTopColor: colors.line },
    field: { gap: 6 },
    label: { fontFamily: font.family.semi, fontSize: 14, color: colors.ink },
    fieldLabel: { fontFamily: font.family.medium, fontSize: 14, lineHeight: 20, color: colors.ink },
    sub: { fontFamily: font.family.regular, fontSize: 12, lineHeight: 17, color: colors.muted },
    body: { fontFamily: font.family.regular, fontSize: 14, lineHeight: 21, color: colors.ink },
    strong: { fontFamily: font.family.semi, color: colors.ink },
    input: { minHeight: 44, paddingHorizontal: space.md, paddingVertical: 10, fontFamily: font.family.medium, fontSize: 15, color: colors.ink },
    inputMulti: { minHeight: 84 },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
    toggle: { minHeight: 36, paddingHorizontal: 12, justifyContent: "center", borderWidth: 1, borderColor: colors.line, borderRadius: radius.pill },
    toggleOn: { backgroundColor: colors.ink, borderColor: colors.ink },
    toggleText: { fontFamily: font.family.medium, fontSize: 13, color: colors.ink },
    toggleTextOn: { color: colors.onInk },
    switchRow: { flexDirection: "row", alignItems: "center", gap: space.md },
    switchText: { flex: 1, gap: 4 },
    row: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: space.sm },
    confirm: { gap: space.sm, marginTop: space.md, paddingTop: space.md, borderTopWidth: 1, borderTopColor: colors.line },
    confirmText: { fontFamily: font.family.semi, fontSize: 14, color: colors.ink },
    primary: { minHeight: 44, paddingHorizontal: 18, alignItems: "center", justifyContent: "center", borderRadius: radius.sm, backgroundColor: colors.ink },
    primaryText: { fontFamily: font.family.semi, fontSize: 14, color: colors.onInk },
    secondary: { minHeight: 44, paddingHorizontal: 18, alignItems: "center", justifyContent: "center", borderRadius: radius.sm, borderWidth: 1, borderColor: colors.line },
    secondaryText: { fontFamily: font.family.semi, fontSize: 14, color: colors.ink },
    disabled: { opacity: 0.4 },
    error: { fontFamily: font.family.regular, fontSize: 12, color: colors.status.redDot },
    saved: { fontFamily: font.family.regular, fontSize: 12, color: colors.status.greenDot },
    previewTitle: { fontFamily: font.family.semi, fontSize: 18, color: colors.ink },
    kv: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md },
    feeNote: { padding: space.sm, borderRadius: radius.sm, backgroundColor: colors.soft, fontFamily: font.family.regular, fontSize: 12, lineHeight: 17, color: colors.muted },
  });
