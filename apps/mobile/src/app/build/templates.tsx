import { useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Screen } from "../../components/Screen";
import { KeyboardAvoider } from "../../components/KeyboardAvoider";
import { Icon } from "../../components/Icon";
import { ZaviTextField } from "../../components/ZaviTextField";
import { useKeyboardOpen } from "../../components/useKeyboardReveal";
import { WebsiteTile } from "../../components/build/WebsiteTile";
import { BuildErrorState, BuildSkeleton } from "../../components/build/BuildStates";
import { CardButton } from "../../components/reply/ui";
import { BackHeader, Intro, settingsStyles } from "../../components/settings/SettingsUI";
import { useSiteTemplates } from "../../features/build/hooks";
import { track } from "../../lib/analytics";
import {
  ANSWER_MAX,
  CONFIRM_NO_BLANKS,
  CONFIRM_WITH_BLANKS,
  TEMPLATES_FAILED,
  TEMPLATES_NOTE,
  TEMPLATES_OPEN,
  TEMPLATES_PREVIEW,
  TEMPLATES_PREVIEW_BACK,
  TEMPLATES_USE,
  blankLabel,
  blankQuestion,
  cleanAnswer,
  fillTemplateIdea,
  templateBlanks,
  templateLook,
  type SiteTemplate,
} from "../../features/build/templates";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

type Step =
  | { kind: "list" }
  | { kind: "preview"; template: SiteTemplate }
  | { kind: "ask"; template: SiteTemplate; at: number }
  | { kind: "confirm"; template: SiteTemplate };

export default function BuildTemplates() {
  const styles = useStyles(makeStyles);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const keyboardOpen = useKeyboardOpen();
  const q = useSiteTemplates();
  const [step, setStep] = useState<Step>({ kind: "list" });
  const [answers, setAnswers] = useState<Record<string, string>>({});

  function pick(t: SiteTemplate) {
    setAnswers({});
    setStep(templateBlanks(t.idea).length > 0 ? { kind: "ask", template: t, at: 0 } : { kind: "confirm", template: t });
  }

  function use(t: SiteTemplate) {
    const idea = fillTemplateIdea(t.idea, answers);
    if (templateBlanks(idea).length > 0) return;
    track("build_template_picked", { template: t.id });
    router.navigate({ pathname: "/build/new", params: { idea, template: t.id, templateLabel: t.label, at: String(Date.now()) } });
  }

  let body: ReactNode;
  let footer: ReactNode = null;
  if (step.kind === "list") {
    body = (
      <>
        <Intro>{TEMPLATES_NOTE}</Intro>
        {q.isLoading ? (
          <BuildSkeleton rows={4} label="Loading templates" />
        ) : q.isError || !q.data ? (
          <BuildErrorState text={TEMPLATES_FAILED} onRetry={() => void q.refetch()} />
        ) : (
          <View style={styles.list}>
            {q.data.map((t) => (
              <TemplateCard key={t.id} template={t} onPick={() => pick(t)} onPreview={() => setStep({ kind: "preview", template: t })} />
            ))}
          </View>
        )}
      </>
    );
  } else if (step.kind === "preview") {
    const t = step.template;
    body = (
      <>
        <Text style={styles.title}>{t.label}</Text>
        <TemplateTile template={t} />
        {t.blurb ? <Text style={styles.blurb}>{t.blurb}</Text> : null}
        {t.good_for ? <Text style={styles.goodFor}>{t.good_for}</Text> : null}
        {t.preview.sections.length > 0 ? (
          <View style={styles.sections} accessibilityLabel="Sections">
            {t.preview.sections.map((s) => (
              <View key={s.title} style={styles.sectionPill}>
                <Text style={styles.sectionText}>{s.title}</Text>
              </View>
            ))}
          </View>
        ) : null}
        <View style={styles.actions}>
          <CardButton label={TEMPLATES_USE} onPress={() => pick(t)} />
          <CardButton label={TEMPLATES_PREVIEW_BACK} variant="secondary" onPress={() => setStep({ kind: "list" })} />
        </View>
      </>
    );
  } else if (step.kind === "ask") {
    const t = step.template;
    const blanks = templateBlanks(t.idea);
    const blank = blanks[step.at];
    const last = step.at === blanks.length - 1;
    const next = () => setStep(last ? { kind: "confirm", template: t } : { kind: "ask", template: t, at: step.at + 1 });
    body = (
      <>
        <Text style={styles.progress}>{`${step.at + 1} of ${blanks.length}`}</Text>
        <Text style={styles.title}>{blankQuestion(blank)}</Text>
        <ZaviTextField
          key={blank}
          value={answers[blank] ?? ""}
          onChangeText={(v) => setAnswers((cur) => ({ ...cur, [blank]: v }))}
          maxLines={1}
          maxLength={ANSWER_MAX}
          placeholder={blankLabel(blank)}
          returnKeyType="next"
          submitBehavior="submit"
          onSubmitEditing={() => cleanAnswer(answers[blank] ?? "") && next()}
          autoFocus
          accessibilityLabel={blankQuestion(blank)}
        />
        <IdeaPreview idea={fillTemplateIdea(t.idea, answers)} />
      </>
    );
    footer = (
      <View style={[styles.footer, { paddingBottom: keyboardOpen ? space.sm : insets.bottom + space.sm }]}>
        <CardButton
          label="Back"
          variant="secondary"
          style={styles.footerBtn}
          onPress={() => setStep(step.at === 0 ? { kind: "list" } : { kind: "ask", template: t, at: step.at - 1 })}
        />
        <CardButton label="Next" disabled={!cleanAnswer(answers[blank] ?? "")} style={styles.footerBtn} onPress={next} />
      </View>
    );
  } else {
    const t = step.template;
    const hasBlanks = templateBlanks(t.idea).length > 0;
    body = (
      <>
        <Text style={styles.progress}>Your idea</Text>
        <IdeaPreview idea={fillTemplateIdea(t.idea, answers)} />
        <Text style={styles.blurb}>{hasBlanks ? CONFIRM_WITH_BLANKS : CONFIRM_NO_BLANKS}</Text>
        <View style={styles.actions}>
          <CardButton label={TEMPLATES_USE} onPress={() => use(t)} />
          <CardButton
            label="Back"
            variant="secondary"
            onPress={() =>
              setStep(hasBlanks ? { kind: "ask", template: t, at: templateBlanks(t.idea).length - 1 } : { kind: "list" })
            }
          />
        </View>
      </>
    );
  }

  return (
    <Screen>
      <BackHeader title={TEMPLATES_OPEN} />
      <KeyboardAvoider style={styles.flex}>
        <ScrollView
          contentContainerStyle={[settingsStyles.content, { paddingBottom: footer ? space.lg : insets.bottom + 20 }]}
          keyboardShouldPersistTaps="handled"
        >
          {body}
        </ScrollView>
        {footer}
      </KeyboardAvoider>
    </Screen>
  );
}

function TemplateTile({ template }: { template: SiteTemplate }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <View style={styles.frame}>
      <WebsiteTile look={templateLook(template, { bg: colors.bg, ink: colors.ink })} fallback={null} />
    </View>
  );
}

function TemplateCard({ template, onPick, onPreview }: { template: SiteTemplate; onPick: () => void; onPreview: () => void }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <View style={styles.card}>
      <Pressable onPress={onPick} accessibilityRole="button" accessibilityLabel={template.label}>
        <TemplateTile template={template} />
        <View style={styles.cardWords}>
          <Text style={styles.cardLabel} numberOfLines={1}>
            {template.label}
          </Text>
          {template.blurb ? (
            <Text style={styles.cardBlurb} numberOfLines={2}>
              {template.blurb}
            </Text>
          ) : null}
          {template.good_for ? (
            <Text style={styles.goodFor} numberOfLines={1}>
              {template.good_for}
            </Text>
          ) : null}
        </View>
      </Pressable>
      {}
      <Pressable
        onPress={onPreview}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={`${TEMPLATES_PREVIEW} ${template.label}`}
        style={styles.previewChip}
      >
        <Icon name="photo" size={13} color={colors.ink} />
        <Text style={styles.previewChipText}>{TEMPLATES_PREVIEW}</Text>
      </Pressable>
    </View>
  );
}

function IdeaPreview({ idea }: { idea: string }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.idea}>
      <Text style={styles.ideaText}>{idea}</Text>
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  flex: { flex: 1 },
  list: { gap: space.lg, marginTop: space.md },
  card: { borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, overflow: "hidden", backgroundColor: colors.panel },
  frame: { borderRadius: radius.sm, overflow: "hidden", borderWidth: 1, borderColor: colors.line },
  cardWords: { padding: space.md, gap: space.xs },
  cardLabel: { fontFamily: font.family.semi, fontSize: font.size.base + 1, includeFontPadding: false, color: colors.ink },
  cardBlurb: { fontFamily: font.family.regular, fontSize: font.size.md, lineHeight: 18, includeFontPadding: false, color: colors.muted },
  goodFor: { fontFamily: font.family.regular, fontSize: font.size.sm, includeFontPadding: false, color: colors.textSecondary },
  previewChip: {
    alignSelf: "flex-start",
    marginHorizontal: space.md,
    marginBottom: space.md,
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
    paddingHorizontal: space.sm + 2,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surfaceRaised,
  },
  previewChipText: { fontFamily: font.family.semi, fontSize: font.size.sm, includeFontPadding: false, color: colors.ink },
  title: { marginBottom: space.md, fontFamily: font.family.semi, fontSize: font.size.lg, lineHeight: 22, includeFontPadding: false, color: colors.ink },
  blurb: { marginTop: space.md, fontFamily: font.family.regular, fontSize: font.size.base, lineHeight: 20, includeFontPadding: false, color: colors.ink },
  sections: { flexDirection: "row", flexWrap: "wrap", gap: space.xs + 2, marginTop: space.md },
  sectionPill: { paddingHorizontal: space.md, paddingVertical: 6, borderRadius: radius.pill, backgroundColor: colors.soft },
  sectionText: { fontFamily: font.family.medium, fontSize: font.size.sm, includeFontPadding: false, color: colors.ink },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginTop: space.lg },
  footer: {
    flexDirection: "row",
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    backgroundColor: colors.bg,
  },
  footerBtn: { flex: 1, height: 40, minHeight: 40 },
  progress: { marginBottom: space.xs, fontFamily: font.family.medium, fontSize: font.size.sm, includeFontPadding: false, color: colors.muted },
  idea: { marginTop: space.md, padding: space.md, borderRadius: radius.md, backgroundColor: colors.soft },
  ideaText: { fontFamily: font.family.regular, fontSize: font.size.base, lineHeight: 20, includeFontPadding: false, color: colors.ink },
});
