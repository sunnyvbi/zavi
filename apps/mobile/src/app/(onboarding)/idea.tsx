import { useEffect, useRef, useState } from "react";
import type { BottomSheetModal } from "@gorhom/bottom-sheet";
import { Image, Keyboard, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { useRouter } from "expo-router";
import { Shell, Heading, ErrorLine } from "../../components/onboarding/Shell";
import { PrimaryButton } from "../../components/onboarding/Buttons";
import { BrainstormSheet } from "../../components/onboarding/BrainstormSheet";
import { FocusRing } from "../../components/ZaviTextField";
import { UnderlinedText } from "../../components/UnderlinedText";
import { Icon } from "../../components/Icon";
import { useOnboarding } from "../../features/onboarding/OnboardingProvider";
import {
  IDEA_EXAMPLES,
  IDEA_EXAMPLES_LABEL,
  IDEA_IMAGE_COUNT_ERROR,
  IDEA_IMAGE_MAX_COUNT,
  IDEA_IMAGE_TYPE_ERROR,
  IDEA_TOO_SHORT_HINT,
  addIdeaImage,
  ideaValid,
} from "../../features/onboarding/idea";
import { getIdeaImages, setIdeaImages } from "../../features/onboarding/ideaImages";
import { LIMITS } from "../../features/onboarding/types";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";
import { track } from "../../lib/analytics";

export default function Idea() {
  const styles = useStyles(makeStyles);
  const { colors, textSelectionColor, keyboardAppearance } = useTheme();
  const router = useRouter();
  const { data, patch, ready, flow } = useOnboarding();
  const input = useRef<TextInput>(null);
  const sheet = useRef<BottomSheetModal>(null);
  const [images, setImages] = useState<string[]>(getIdeaImages());
  const [imageError, setImageError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const mode = flow === "add" ? "add_company" : flow ?? "first";
  const viewed = useRef(false);

  useEffect(() => {
    if (!ready || viewed.current) return;
    viewed.current = true;
    track("onboarding_step_viewed", { step: "idea", mode });
  }, [ready, mode]);

  if (!ready) return null;

  const idea = data.description;
  const valid = ideaValid(idea);
  const full = images.length >= IDEA_IMAGE_MAX_COUNT;

  function setIdea(text: string) {
    patch({ noSite: true, website: "", workspace: "", description: text });
  }

  function keep(next: string[]) {
    setImages(next);
    setIdeaImages(next);
  }

  async function attach() {
    Keyboard.dismiss();
    setImageError(null);
    if (full) {
      setImageError(IDEA_IMAGE_COUNT_ERROR);
      return;
    }
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setImageError("Photo access is needed to attach an image.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.7,
      base64: true,
      allowsMultipleSelection: true,
      selectionLimit: IDEA_IMAGE_MAX_COUNT - images.length,
    });
    if (result.canceled) return;
    let next = images;
    let problem: string | null = null;
    for (const a of result.assets) {
      if (!a.base64) {
        problem = IDEA_IMAGE_TYPE_ERROR;
        continue;
      }
      const r = addIdeaImage(next, a.base64, a.mimeType ?? "image/jpeg");
      if ("error" in r) problem = r.error;
      else next = r.images;
    }
    setImageError(problem);
    if (next !== images) keep(next);
  }

  function onBuild() {
    Keyboard.dismiss();
    if (!valid) {
      setTouched(true);
      return;
    }
    track("onboarding_idea_submitted");
    patch({ noSite: true, website: "", workspace: "", description: idea.trim() });
    router.push("/(onboarding)/notifications");
  }

  return (
    <Shell step={2} onBack={() => router.back()} footer={<PrimaryButton label="Build it" onPress={onBuild} dimmed={!valid} />}>
      <Heading
        title="What’s your idea?"
        sub="Zavi thinks, builds, and markets your project autonomously. It plans, codes, deploys it, and gives you a live URL. Refine it by chat after."
      />

      <FocusRing radius={radius.md}>
        {(focus) => (
          <TextInput
            keyboardAppearance={keyboardAppearance}
            ref={input}
            style={styles.box}
            value={idea}
            onChangeText={(t) => {
              setIdea(t);
              if (!touched) setTouched(true);
            }}
            placeholder="Type your idea…"
            placeholderTextColor={colors.form.placeholder}
            cursorColor={colors.ink}
            selectionColor={textSelectionColor}
            selectionHandleColor={colors.ink}
            multiline
            textAlignVertical="top"
            maxLength={LIMITS.idea}
            autoFocus
            accessibilityLabel="Your idea"
            onFocus={focus.onFocus}
            onBlur={focus.onBlur}
          />
        )}
      </FocusRing>
      {touched && idea.trim().length > 0 && !valid ? <Text style={styles.hint}>{IDEA_TOO_SHORT_HINT}</Text> : null}

      {idea.trim().length === 0 ? (
        <View style={styles.examples}>
          <Text style={styles.hint}>{IDEA_EXAMPLES_LABEL}</Text>
          <View style={styles.chips}>
            {IDEA_EXAMPLES.map((ex) => (
              <Pressable
                key={ex.label}
                style={({ pressed }) => [styles.chip, pressed && styles.pressed]}
                onPress={() => {
                  setIdea(ex.idea);
                  input.current?.focus();
                }}
                accessibilityRole="button"
              >
                <Text style={styles.chipText}>{ex.label}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}

      <Pressable
        style={styles.brainstorm}
        onPress={() => {
          Keyboard.dismiss();
          track("onboarding_brainstorm_opened");
          sheet.current?.present();
        }}
        accessibilityRole="button"
        accessibilityLabel="Brainstorm it"
      >
        <Text style={styles.brainText}>
          {"💡  Not sure yet? "}
        </Text>
        <UnderlinedText style={styles.brainLink}>Brainstorm it</UnderlinedText>
        <Text style={styles.brainText}>{" →"}</Text>
      </Pressable>

      {}
      <Pressable
        style={({ pressed }) => [styles.attach, pressed && !full && styles.attachPressed, full && styles.dim]}
        onPress={() => void attach()}
        disabled={full}
        accessibilityRole="button"
        accessibilityLabel="Attach image"
        accessibilityState={{ disabled: full }}
      >
        <Icon name="paperclip" size={17} color={colors.ink} />
        <Text style={styles.attachText}>{`Attach image (${images.length}/${IDEA_IMAGE_MAX_COUNT})`}</Text>
      </Pressable>
      <Text style={styles.attachHint}>PNG, JPEG or WebP, up to 5 MB each.</Text>
      {images.length > 0 ? (
        <View style={styles.thumbs}>
          {images.map((uri, i) => (
            <View key={i} style={styles.thumb}>
              <Image source={{ uri }} style={styles.thumbImg} />
              <Pressable
                style={styles.remove}
                onPress={() => {
                  Keyboard.dismiss();
                  keep(images.filter((_, j) => j !== i));
                }}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel={`Remove image ${i + 1}`}
              >
                <Icon name="close" size={12} color={colors.onInk} strokeWidth={2.2} />
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
      <ErrorLine message={imageError} />

      <BrainstormSheet
        ref={sheet}
        seedIdea={idea}
        onUseIdea={(brief) => setIdea(brief.slice(0, LIMITS.idea))}
      />
    </Shell>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    box: {
      minHeight: 140,
      padding: space.md,
      fontFamily: font.family.medium,
      fontSize: 15,
      lineHeight: 24,
      color: colors.ink,
    },
    hint: { marginTop: space.sm, fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.form.soft },
    examples: { marginTop: space.md },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginTop: space.sm },
    chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.form.edge },
    chipText: { fontFamily: font.family.regular, fontSize: 14, color: colors.ink },
    pressed: { opacity: 0.7 },
    brainstorm: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", marginTop: space.md, minHeight: 36 },
    brainText: { fontFamily: font.family.regular, fontSize: 16, color: colors.form.soft },
    brainLink: { fontFamily: font.family.semi, fontSize: 16, color: colors.ink },
    attach: {
      marginTop: space.md,
      minHeight: 44,
      borderRadius: 13,
      borderWidth: 1,
      borderColor: colors.line,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: space.sm,
      paddingHorizontal: space.md,
      backgroundColor: colors.bg,
    },
    attachPressed: { opacity: 0.8 },
    attachText: { flexShrink: 1, fontFamily: font.family.semi, fontSize: font.size.base, lineHeight: 18, includeFontPadding: false, color: colors.ink, textAlign: "center" },
    attachHint: { marginTop: space.sm, fontFamily: font.family.regular, fontSize: font.size.sm, lineHeight: 16, includeFontPadding: false, color: colors.muted },
    dim: { opacity: 0.5 },
    thumbs: { flexDirection: "row", gap: space.sm, marginTop: space.sm },
    thumb: { width: 64, height: 64 },
    thumbImg: { width: 64, height: 64, borderRadius: radius.sm },
    remove: { position: "absolute", top: -6, right: -6, width: 20, height: 20, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: colors.ink },
  });
