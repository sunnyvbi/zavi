import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useResetBrandKit, useSaveBrandVoice } from "../../features/growth/hooks";
import {
  BASE_TONES,
  BRAND_VOICE_MAX,
  COLOURS_NOTE_MANUAL,
  COLOURS_NOTE_SITE,
  COLOUR_FIELDS,
  TONE_LABEL,
  VOICE_PLACEHOLDER,
  VOICE_REQUIRED,
  colourPlaceholder,
  coloursChanged,
  invalidColour,
  isHex,
  toColourDraft,
  voiceDraftOf,
  voicePatch,
  type BrandKit,
  type ColourDraft,
  type VoiceDraft,
} from "../../features/growth/knowledge";
import type { Personalization } from "../../features/personalization/usePersonalization";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles } from "../../theme/theme";
import { FieldHint, SheetInput } from "./SheetFields";
import { ActionButton, ErrorLine, SubLabel, TextLink } from "./StoryKit";

export function BrandVoiceEditor({
  voice,
  kit,
  seedVoice,
  onClose,
  onSaved,
  requireVoice = false,
}: {
  voice: Personalization;
  kit: BrandKit | null;
  seedVoice?: string;
  onClose: () => void;
  onSaved: () => void;
  requireVoice?: boolean;
}) {
  const styles = useStyles(makeStyles);
  const save = useSaveBrandVoice();
  const reset = useResetBrandKit();
  const [draft, setDraft] = useState<VoiceDraft>(() => voiceDraftOf(voice, seedVoice));
  const [colours, setColours] = useState<ColourDraft | null>(() => (kit ? toColourDraft(kit) : null));
  const [error, setError] = useState<string | null>(null);
  const busy = save.isPending || reset.isPending;

  const commit = async () => {
    if (busy) return;
    if (requireVoice && !draft.brand_voice.trim()) return setError(VOICE_REQUIRED);
    if (colours) {
      const bad = invalidColour(colours);
      if (bad) return setError(bad);
    }
    setError(null);
    try {
      await save.mutateAsync({
        patch: voicePatch(draft, voice.response_rules ?? ""),
        colours: colours && kit && coloursChanged(colours, toColourDraft(kit)) ? colours : undefined,
      });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const useSite = async () => {
    if (busy) return;
    setError(null);
    try {
      const next = await reset.mutateAsync();
      if (next) setColours(toColourDraft(next));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <View style={styles.wrap}>
      <SubLabel>How we sound</SubLabel>
      <SheetInput
        label="How we sound"
        value={draft.brand_voice}
        onChange={(v) => setDraft({ ...draft, brand_voice: v.slice(0, BRAND_VOICE_MAX) })}
        placeholder={VOICE_PLACEHOLDER}
        multiline
      />
      <Text style={styles.count}>{`${draft.brand_voice.length} of ${BRAND_VOICE_MAX} characters`}</Text>

      <SubLabel>Tone</SubLabel>
      <View style={styles.chips}>
        {BASE_TONES.map((t) => (
          <Chip key={t} label={TONE_LABEL[t]} on={draft.base_tone === t} onPress={() => setDraft({ ...draft, base_tone: t })} />
        ))}
        <Chip label="Warm" on={draft.warm} onPress={() => setDraft({ ...draft, warm: !draft.warm })} />
        <Chip label="Enthusiastic" on={draft.enthusiastic} onPress={() => setDraft({ ...draft, enthusiastic: !draft.enthusiastic })} />
      </View>

      <SubLabel>Never say</SubLabel>
      <SheetInput
        label="Words to never say"
        value={draft.never_say}
        onChange={(v) => setDraft({ ...draft, never_say: v })}
        placeholder="artisanal, curated, game-changing"
      />
      <FieldHint>Separate words with commas.</FieldHint>

      {colours ? (
        <>
          <SubLabel>Colours</SubLabel>
          <View style={styles.colours}>
            {COLOUR_FIELDS.map(([key, label]) => (
              <View key={key} style={styles.colour}>
                {}
                <View style={[styles.swatch, isHex(colours[key]) && { backgroundColor: colours[key] }]} />
                <View style={styles.colourInput}>
                  <SheetInput
                    label={`${label} colour`}
                    value={colours[key]}
                    onChange={(v) => setColours({ ...colours, [key]: v })}
                    placeholder={colourPlaceholder(key)}
                  />
                </View>
              </View>
            ))}
          </View>
          <FieldHint>{kit?.source === "manual" ? COLOURS_NOTE_MANUAL : COLOURS_NOTE_SITE}</FieldHint>
          {kit?.source === "manual" ? <TextLink label="Use my site’s colours again" onPress={() => void useSite()} disabled={busy} /> : null}
        </>
      ) : null}

      {error ? <ErrorLine>{error}</ErrorLine> : null}
      <View style={styles.actions}>
        <ActionButton label="Cancel" variant="secondary" grow disabled={busy} onPress={onClose} />
        <ActionButton label="Save" grow busy={save.isPending} busyLabel="Saving…" onPress={() => void commit()} />
      </View>
      <FieldHint>Takes effect on the next agent run.</FieldHint>
    </View>
  );
}

function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  const styles = useStyles(makeStyles);
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.chip, on && styles.chipOn, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
    >
      <Text style={[styles.chipText, on && styles.chipTextOn]}>{label}</Text>
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    wrap: { gap: space.sm },
    count: { fontFamily: font.family.regular, fontSize: 12, lineHeight: 16, includeFontPadding: false, color: colors.muted },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    chip: { minHeight: 40, justifyContent: "center", borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 14 },
    chipOn: { backgroundColor: colors.ink, borderColor: colors.ink },
    chipText: { fontFamily: font.family.medium, fontSize: 13, lineHeight: 17, includeFontPadding: false, color: colors.ink },
    chipTextOn: { fontFamily: font.family.semi, color: colors.onInk },
    pressed: { opacity: 0.8 },
    colours: { gap: space.sm },
    colour: { flexDirection: "row", alignItems: "center", gap: space.md },
    swatch: { width: 28, height: 28, borderRadius: 8, borderWidth: 1, borderColor: colors.line },
    colourInput: { flex: 1 },
    actions: { flexDirection: "row", gap: space.md, marginTop: space.md },
  });
