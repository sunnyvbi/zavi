import { useEffect, useState } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { AppBottomSheet } from "../AppBottomSheet";
import { CardButton } from "../reply/ui";
import { Field, Pills, useSaver } from "./CampaignParts";
import { pickImages, uploadChatFile } from "../../features/agents/uploadImage";
import {
  AD_NOTE,
  SAVED_PAUSED,
  SPEC,
  adProblem,
  adRequest,
  bidText,
  groupProblem,
  groupRequest,
  trackingFor,
  type AdForm,
  type Campaign,
  type Draft,
  type Entity,
  type GroupForm,
} from "../../features/channels/managedCampaigns";
import { campaignFetch } from "../../features/channels/managedCampaignsHooks";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

export function GroupSheet({
  open,
  campaign,
  editing,
  draft,
  currency,
  onClose,
  onSaved,
}: {
  open: boolean;
  campaign: Campaign | undefined;
  editing: Entity | null;
  draft: Draft | undefined;
  currency: string | null;
  onClose: () => void;
  onSaved: (receipt: { id?: string; status?: string }) => void;
}) {
  const styles = useStyles(makeStyles);
  const { save, busy, error, clearError } = useSaver();
  const objective = SPEC.objectives.find((o) => o.value === campaign?.bidding_type);
  const automatic = objective?.automaticStrategy && campaign?.budget?.daily_spend_limit_micros != null ? objective.automaticStrategy : null;
  const [form, setForm] = useState<GroupForm>({ name: "", hints: "", strategy: "fixed_bid", bid: "" });

  useEffect(() => {
    if (!open) return;
    setForm({
      name: editing?.name ?? "",
      hints: (editing?.context_hints ?? draft?.group.context_hints ?? []).join("\n"),
      strategy: editing?.bidding_config?.strategy ?? "fixed_bid",
      bid: bidText(editing, campaign),
    });
    clearError();
  }, [open, editing?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const problem = campaign ? groupProblem(form, campaign) : "Choose a campaign first.";
  const set = (patch: Partial<GroupForm>) => setForm((f) => ({ ...f, ...patch }));

  async function submit() {
    if (!campaign || problem) return;
    const receipt = await save<{ id?: string; status?: string }>(groupRequest(campaign.id, campaign, form, editing?.id ?? null));
    if (receipt) onSaved(receipt);
  }

  return (
    <AppBottomSheet open={open} onClose={onClose} title={editing ? "Edit ad group" : "Add ad group"} locked={busy}>
      <View style={styles.sheet}>
        <Field label="Name" value={form.name} onChangeText={(v) => set({ name: v })} />
        <Field label={SPEC.creative.contextLabel} value={form.hints} onChangeText={(v) => set({ hints: v })} multiline placeholder="One situation or question per line" />
        <Pills
          label="Bid strategy"
          options={[{ value: "fixed_bid", label: "Fixed bid" }, ...(automatic ? [{ value: automatic, label: `Maximize ${campaign?.bidding_type}` }] : [])]}
          value={form.strategy}
          onPick={(v) => set({ strategy: v })}
        />
        {form.strategy === "fixed_bid" ? (
          <Field label={`${objective?.bidLabel ?? "Maximum bid"} (${currency ?? "account currency"})`} value={form.bid} onChangeText={(v) => set({ bid: v })} keyboardType="decimal-pad" />
        ) : null}
        {objective?.requiresEvent ? (
          <Text style={styles.hint}>This bid guides conversion optimization. Billing is per valid click; it is not a guaranteed cost per conversion.</Text>
        ) : null}
        <Text style={styles.hint}>{SAVED_PAUSED}</Text>
        {error || problem ? (
          <Text style={styles.error} accessibilityRole="alert">
            {error ?? problem}
          </Text>
        ) : null}
        <View style={styles.footer}>
          <CardButton label="Cancel" variant="secondary" onPress={onClose} disabled={busy} />
          <CardButton label="Save paused" onPress={() => void submit()} busy={busy} disabled={!!problem} />
        </View>
      </View>
    </AppBottomSheet>
  );
}

export function AdSheet({
  open,
  campaign,
  groups,
  editing,
  draft,
  onClose,
  onSaved,
}: {
  open: boolean;
  campaign: Campaign | undefined;
  groups: Entity[];
  editing: Entity | null;
  draft: Draft | undefined;
  onClose: () => void;
  onSaved: (receipt: { id?: string; status?: string }) => void;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const { save, busy, error, clearError } = useSaver();
  const product = campaign?.mode === "product_feed";
  const [form, setForm] = useState<AdForm>({ group: "", name: "", title: "", body: "", url: "", image: null, tracking: "" });
  const [local, setLocal] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const [signed, setSigned] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const d = draft?.ads[0];
    setForm({
      group: editing?.ad_group_id ?? groups[0]?.id ?? "",
      name: editing?.name ?? d?.name ?? "",
      title: editing?.creative?.title ?? d?.title ?? "",
      body: editing?.creative?.body ?? d?.body ?? "",
      url: editing?.creative?.target_url ?? d?.target_url ?? "",
      image: null,
      tracking: editing?.landing_page_configuration?.query_string_template ?? trackingFor(d?.tracking ?? SPEC.creative.tracking, editing?.creative?.target_url),
    });
    setLocal(null);
    setSigned(null);
    setImageError(null);
    clearError();
  }, [open, editing?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const v = form.image;
    if (!v || /^https?:\/\//i.test(v) || local) {
      setSigned(null);
      return;
    }
    let live = true;
    campaignFetch<{ signed_url: string }>(`/api/chat/image-url?path=${encodeURIComponent(v)}`)
      .then((r) => live && setSigned(r.signed_url))
      .catch(() => live && setSigned(null));
    return () => {
      live = false;
    };
  }, [form.image, local]);

  const set = (patch: Partial<AdForm>) => setForm((f) => ({ ...f, ...patch }));
  const problem = adProblem(form, campaign, editing);
  const preview = local ?? (form.image && /^https?:\/\//i.test(form.image) ? form.image : signed);

  async function choose() {
    setImageError(null);
    try {
      const [img] = await pickImages(1, setImageError);
      if (!img) return;
      setUploading(true);
      const path = await uploadChatFile(img.uri, "/api/chat/upload-image", "image_path");
      setLocal(img.uri);
      set({ image: path });
    } catch (e) {
      setImageError(e instanceof Error ? e.message : "The image could not be uploaded.");
    } finally {
      setUploading(false);
    }
  }

  async function submit() {
    if (!campaign || problem) return;
    const receipt = await save<{ id?: string; status?: string }>(adRequest(campaign, campaign.id, form, editing));
    if (receipt) onSaved(receipt);
  }

  return (
    <AppBottomSheet open={open} onClose={onClose} title={editing ? "Edit ad" : "Add ad"} locked={busy || uploading}>
      <View style={styles.sheet}>
        {!editing ? (
          <Pills label="Ad group" options={groups.map((g) => ({ value: g.id, label: g.name }))} value={form.group} onPick={(v) => set({ group: v })} />
        ) : null}
        <Field label="Name" value={form.name} onChangeText={(v) => set({ name: v })} />
        <Field label={`Title (3–${SPEC.creative.titleLimit} characters)`} value={form.title} onChangeText={(v) => set({ title: v })} maxLength={SPEC.creative.titleLimit} />
        <Field label={`Ad copy (up to ${SPEC.creative.bodyLimit} characters)`} value={form.body} onChangeText={(v) => set({ body: v })} maxLength={SPEC.creative.bodyLimit} multiline />
        {!product ? (
          <>
            <Field label="Sending visitors to" value={form.url} onChangeText={(v) => set({ url: v })} keyboardType="url" placeholder="https://example.com/offer" />
            <View style={styles.image}>
              <Text style={styles.label}>{editing ? "Replacement image (optional)" : "Ad image"}</Text>
              {preview ? <Image source={{ uri: preview }} style={styles.preview} accessibilityLabel="Ad image preview" /> : null}
              <View style={styles.footer}>
                <CardButton label={form.image ? "Change image" : "Choose image"} variant="secondary" onPress={() => void choose()} busy={uploading} disabled={busy} />
                {form.image ? (
                  <Pressable onPress={() => (set({ image: null }), setLocal(null))} accessibilityRole="button">
                    <Text style={[styles.hint, { color: colors.ink }]}>Remove</Text>
                  </Pressable>
                ) : null}
              </View>
              <Text style={styles.hint}>JPG, PNG or WebP, up to 5 MB.</Text>
              {imageError ? <Text style={styles.error}>{imageError}</Text> : null}
            </View>
          </>
        ) : (
          <Text style={styles.hint}>Images and destinations come from the selected product catalog.</Text>
        )}
        <Field label="Tracking" value={form.tracking} onChangeText={(v) => set({ tracking: v })} />
        <Text style={styles.hint}>{AD_NOTE}</Text>
        <Text style={styles.hint}>{SAVED_PAUSED}</Text>
        {error || problem ? (
          <Text style={styles.error} accessibilityRole="alert">
            {error ?? problem}
          </Text>
        ) : null}
        <View style={styles.footer}>
          <CardButton label="Cancel" variant="secondary" onPress={onClose} disabled={busy} />
          <CardButton label="Save paused" onPress={() => void submit()} busy={busy} disabled={!!problem || uploading} />
        </View>
      </View>
    </AppBottomSheet>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    sheet: { gap: space.lg },
    hint: { fontFamily: font.family.regular, fontSize: 12, lineHeight: 17, color: colors.muted },
    error: { fontFamily: font.family.medium, fontSize: 13, lineHeight: 19, color: colors.red },
    label: { fontFamily: font.family.medium, fontSize: 13, color: colors.ink },
    footer: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: space.sm },
    image: { gap: space.sm },
    preview: { width: "100%", height: 160, borderRadius: radius.md, backgroundColor: colors.soft },
  });
