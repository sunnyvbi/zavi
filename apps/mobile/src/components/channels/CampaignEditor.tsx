import { campaignLocationDetail } from "@zavi/shared";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { AppBottomSheet } from "../AppBottomSheet";
import { CardButton } from "../reply/ui";
import { CheckRow, Field, Group, Pills, toggle, useSaver } from "./CampaignParts";
import { Pressable } from "react-native";
import { Icon } from "../Icon";
import { ZaviTextField } from "../ZaviTextField";
import {
  DAILY_NOTE,
  EDITOR_NOTE,
  SPEC,
  editBlocked,
  formFrom,
  formProblem,
  saveRequest,
  type Campaign,
  type Draft,
  type EditorForm,
} from "../../features/channels/managedCampaigns";
import { searchLocations, useCampaignDetail, useResources, type Place } from "../../features/channels/managedCampaignsHooks";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

export function CampaignEditor({
  open,
  existingId,
  draft,
  prefix,
  currency,
  version,
  onClose,
  onSaved,
}: {
  open: boolean;
  existingId: string | null;
  draft: Draft | undefined;
  prefix: string | undefined;
  currency: string | null;
  version: number;
  onClose: () => void;
  onSaved: (campaign: Campaign | undefined) => void;
}) {
  const styles = useStyles(makeStyles);
  const detail = useCampaignDetail(open ? existingId : null, version);
  const resources = useResources(open);
  const options = resources.data;
  const existing: Campaign | null = existingId ? (detail.data ?? null) : null;
  const [form, setForm] = useState<EditorForm | null>(null);
  const { save, busy, error, clearError } = useSaver();
  const loadedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!open) {
      loadedFor.current = null;
      return;
    }
    if (existingId ? !existing : false) return;
    const token = `${existingId ?? "new"}:${existing?.updated_at ?? 0}`;
    if (loadedFor.current === token) return;
    loadedFor.current = token;
    setForm(formFrom(existing, draft, prefix ?? ""));
    clearError();
  }, [open, existingId, existing, draft, prefix]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = <K extends keyof EditorForm>(k: K, v: EditorForm[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const objective = SPEC.objectives.find((o) => o.value === form?.objective);
  const problem = form ? formProblem(form, currency, existing) : null;
  const blocked = existing ? editBlocked(existing) : null;

  async function submit() {
    if (!form || problem) return;
    const res = await save<{ campaign?: Campaign }>(saveRequest(form, existing));
    if (res) onSaved(res.campaign);
  }

  return (
    <AppBottomSheet open={open} onClose={onClose} title={existingId ? "Edit paused campaign" : "New campaign"} locked={busy}>
      {!form ? (
        <Text style={styles.body}>{existingId && detail.isError ? "This campaign could not be read. Close and try again." : "Loading…"}</Text>
      ) : (
        <View style={styles.sheet}>
          {blocked ? <Text style={styles.warn}>{blocked}</Text> : null}
          {options?.warnings.map((w) => (
            <Text key={w} style={styles.hint}>{w}</Text>
          ))}

          <Field label="Name" value={form.name} onChangeText={(v) => set("name", v)} hint={prefix ? `Saved as ${prefix}…` : undefined} />
          <Pills label="Objective" options={SPEC.objectives.map((o) => ({ value: o.value, label: o.label }))} value={form.objective} onPick={(v) => (existing ? null : set("objective", v))} />
          {existing ? <Text style={styles.hint}>The objective cannot change after a campaign is created.</Text> : null}
          {objective?.requiresEvent ? (
            <Group title="Conversion event">
              {options?.conversion_events.length ? (
                options.conversion_events.map((e) => (
                  <CheckRow key={e.id} label={e.name} checked={form.event === e.id} disabled={!!existing} onPress={() => set("event", e.id)} />
                ))
              ) : (
                <Text style={styles.hint}>No verified conversion events were found. Set one up on zaviagent.com first.</Text>
              )}
            </Group>
          ) : null}

          <Pills label="Budget type" options={[{ value: "daily", label: "Daily" }, { value: "lifetime", label: "Lifetime" }]} value={form.budgetType} onPick={(v) => (existing ? null : set("budgetType", v as EditorForm["budgetType"]))} />
          <Field label={`Budget${currency ? ` (${currency})` : ""}`} value={form.budget} onChangeText={(v) => set("budget", v)} keyboardType="decimal-pad" hint={form.budgetType === "daily" ? DAILY_NOTE : undefined} />
          <Field label="Start (your time)" value={form.start} onChangeText={(v) => set("start", v)} placeholder="2026-10-12 09:00:00" keyboardType="numbers-and-punctuation" />
          <Field label="End (your time)" value={form.end} onChangeText={(v) => set("end", v)} placeholder="2026-11-12 09:00:00" keyboardType="numbers-and-punctuation" />

          <Group title="Where ads show">
            <Field label="Countries" value={form.countries} onChangeText={(v) => set("countries", v)} placeholder="US, CA" hint="Two-letter country codes, separated by commas." />
            <PlacePicker label="Include places" picked={form.locations} onChange={(v) => set("locations", v)} />
            <Field label="Exclude countries" value={form.excludedCountries} onChangeText={(v) => set("excludedCountries", v)} placeholder="Optional" />
            <PlacePicker label="Exclude places" picked={form.excludedLocations} onChange={(v) => set("excludedLocations", v)} />
          </Group>

          <Group title="Platforms">
            {SPEC.platforms.map((p) => (
              <CheckRow key={p.value} label={p.label} checked={form.platforms.includes(p.value)} onPress={() => set("platforms", toggle(form.platforms, p.value))} />
            ))}
          </Group>

          {options?.inclusion_audiences.length ? (
            <Group title="Include audiences">
              {options.inclusion_audiences.map((a) => (
                <CheckRow key={a.id} label={a.name} checked={form.included.includes(a.id)} onPress={() => set("included", toggle(form.included, a.id))} />
              ))}
            </Group>
          ) : null}
          {options?.exclusion_audiences.length ? (
            <Group title="Exclude audiences">
              {options.exclusion_audiences.map((a) => (
                <CheckRow key={a.id} label={a.name} checked={form.excluded.includes(a.id)} onPress={() => set("excluded", toggle(form.excluded, a.id))} />
              ))}
            </Group>
          ) : null}

          {!existing && options?.product_feeds.length ? (
            <Group title="Creative source">
              <CheckRow label="Write chat cards" checked={!form.feed} onPress={() => set("feed", "")} />
              {options.product_feeds.map((f) => (
                <CheckRow key={f.id} label={`Product feed: ${f.name}`} checked={form.feed === f.id} onPress={() => set("feed", f.id)} />
              ))}
            </Group>
          ) : null}

          <Field label="Tracking template" value={form.template} onChangeText={(v) => set("template", v)} placeholder={SPEC.creative.tracking} />

          <Text style={styles.hint}>{EDITOR_NOTE}</Text>
          {error || (problem && !blocked) ? (
            <Text style={styles.error} accessibilityRole="alert">
              {error ?? problem}
            </Text>
          ) : null}
          <View style={styles.footer}>
            <CardButton label="Cancel" variant="secondary" onPress={onClose} disabled={busy} />
            <CardButton label={existingId ? "Save paused" : "Create paused"} onPress={() => void submit()} busy={busy} disabled={!!problem || !!blocked} />
          </View>
        </View>
      )}
    </AppBottomSheet>
  );
}

export function PlacePicker({ label, picked, onChange }: { label: string; picked: Place[]; onChange: (v: Place[]) => void }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Place[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setFound([]);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      searchLocations(term).then((r) => live && (setFound(r), setFailed(false))).catch(() => live && setFailed(true));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);

  const shown = found.filter((p) => !picked.some((x) => x.id === p.id)).slice(0, 6);
  return (
    <View style={styles.place}>
      <Text style={styles.label}>{label}</Text>
      <ZaviTextField inSheet value={q} onChangeText={setQ} placeholder="Search for a location" accessibilityLabel={label} autoCorrect={false} multiline={false} />
      {shown.map((p) => (
        <Pressable key={p.id} style={styles.result} onPress={() => (onChange([...picked, p]), setQ(""))} accessibilityRole="button" accessibilityLabel={`Add ${[p.name ?? p.id, campaignLocationDetail(p)].filter(Boolean).join(" · ")}`}>
          <Text style={styles.resultText}>{p.name ?? p.id}</Text>
          {campaignLocationDetail(p) ? <Text style={styles.hint}>{campaignLocationDetail(p)}</Text> : null}
        </Pressable>
      ))}
      {failed ? <Text style={styles.hint}>Places could not be searched just now.</Text> : null}
      {picked.length ? (
        <View style={styles.chips}>
          {picked.map((p) => (
            <Pressable key={p.id} style={styles.chip} onPress={() => onChange(picked.filter((x) => x.id !== p.id))} accessibilityRole="button" accessibilityLabel={`Remove ${[p.name ?? p.id, campaignLocationDetail(p)].filter(Boolean).join(" · ")}`}>
              <Text style={styles.chipText}>{[p.name ?? p.id, campaignLocationDetail(p)].filter(Boolean).join(" · ")}</Text>
              <Icon name="close" size={12} color={colors.ink} strokeWidth={2} />
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    sheet: { gap: space.lg },
    body: { fontFamily: font.family.regular, fontSize: 14, color: colors.textSecondary },
    hint: { fontFamily: font.family.regular, fontSize: 12, lineHeight: 17, color: colors.muted },
    warn: { padding: space.md, borderRadius: radius.md, backgroundColor: colors.soft, fontFamily: font.family.medium, fontSize: 13, lineHeight: 19, color: colors.textSecondary },
    error: { fontFamily: font.family.medium, fontSize: 13, lineHeight: 19, color: colors.red },
    footer: { flexDirection: "row", justifyContent: "flex-end", gap: space.sm },
    place: { gap: 6 },
    label: { fontFamily: font.family.medium, fontSize: 14, color: colors.ink },
    input: { minHeight: 42, paddingHorizontal: space.md, fontFamily: font.family.medium, fontSize: 15, color: colors.ink },
    result: { minHeight: 44, justifyContent: "center", paddingHorizontal: space.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
    resultText: { fontFamily: font.family.medium, fontSize: 14, color: colors.ink },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
    chip: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4, paddingLeft: 10, paddingRight: 8, borderRadius: radius.md, backgroundColor: colors.soft },
    chipText: { fontFamily: font.family.medium, fontSize: 13, color: colors.ink },
  });
