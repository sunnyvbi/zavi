import { useEffect, useRef, useState } from "react";
import { BUILD_ESTIMATE_NOTE } from "@zavi/shared";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { Screen } from "../../components/Screen";
import { KeyboardAvoider } from "../../components/KeyboardAvoider";
import { CreditWallNotice } from "../../components/CreditWallNotice";
import { FullScreenLoader } from "../../components/FullScreenLoader";
import { Icon } from "../../components/Icon";
import { ZaviTextField } from "../../components/ZaviTextField";
import {
  BackHeader,
  Intro,
  Message,
  PrimaryButton,
  settingsStyles,
} from "../../components/settings/SettingsUI";
import { useWorkspace } from "../../features/workspaces/WorkspaceProvider";
import { useActiveTenant } from "../../features/workspaces/useActiveTenant";
import { startBuild } from "../../features/build/api";
import { buildKeys } from "../../features/build/hooks";
import { failureReason, track } from "../../lib/analytics";
import {
  COMPANY_MAX_CHARS,
  IDEA_MAX_CHARS,
  buildCreditWall,
  buildErrorMessage,
  validateCompanyName,
  validateIdea,
} from "../../features/build/logic";
import { TEMPLATES_OPEN, blanksHint, templateBlanks } from "../../features/build/templates";
import type { CreditWall } from "../../features/agents/creditWall";
import { font, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

export default function NewBuild() {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const qc = useQueryClient();
  const tenant = useActiveTenant();
  const { tenants, activeTenantId } = useWorkspace();
  const workspaceName = tenants.find((t) => t.tenant_id === activeTenantId)?.display_name ?? "";

  const params = useLocalSearchParams<{ idea?: string; template?: string; templateLabel?: string; at?: string }>();
  const [idea, setIdea] = useState(typeof params.idea === "string" ? params.idea : "");
  const [company, setCompany] = useState(workspaceName);
  const [template, setTemplate] = useState<{ id: string; label: string } | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wall, setWall] = useState<CreditWall | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    if (typeof params.template !== "string" || !params.template) return;
    setTemplate({ id: params.template, label: typeof params.templateLabel === "string" ? params.templateLabel : params.template });
    if (typeof params.idea === "string") setIdea(params.idea);
    setError(null);
  }, [params.template, params.templateLabel, params.idea, params.at]);

  const blanks = template ? templateBlanks(idea) : [];
  const ideaCheck = validateIdea(idea);
  const companyCheck = validateCompanyName(company);
  const canStart = ideaCheck.ok && companyCheck.ok && blanks.length === 0 && !starting;

  async function onStart() {
    if (inFlight.current || !canStart) return;
    inFlight.current = true;
    setStarting(true);
    setError(null);
    setWall(null);
    try {
      const id = await startBuild({ idea, companyName: company, template: template?.id ?? null });
      track("build_started", { source: "form" });
      void qc.invalidateQueries({ queryKey: buildKeys.sessions(tenant) });
      router.replace({ pathname: "/build/[id]", params: { id } });
    } catch (e) {
      track("build_start_failed", { source: "form", reason: failureReason(e) });
      const w = buildCreditWall(e, "build");
      if (w) setWall(w);
      else setError(buildErrorMessage(e, "Couldn't start the build. Please try again."));
      inFlight.current = false;
      setStarting(false);
    }
  }

  const ideaHint = idea.trim().length > 0 && !ideaCheck.ok ? ideaCheck.reason : null;

  return (
    <Screen>
      <BackHeader title="New build" />
      <KeyboardAvoider style={styles.flex}>
        <ScrollView
          contentContainerStyle={[settingsStyles.content, { paddingBottom: insets.bottom + 20 }]}
          keyboardShouldPersistTaps="handled"
        >
          <Intro>{`Describe the app you want. ${BUILD_ESTIMATE_NOTE}`}</Intro>

          <ZaviTextField
            title="Your idea"
            containerStyle={styles.field}
            value={idea}
            onChangeText={(t) => {
              setIdea(t);
              setError(null);
            }}
            minLines={3}
            maxLines={6}
            maxLength={IDEA_MAX_CHARS}
            placeholder="A booking site for my dog-walking business, with a calendar and payments"
            editable={!starting}
            accessibilityLabel="Your idea"
          />
          {ideaHint ? <Text style={styles.hint}>{ideaHint}</Text> : null}
          {blanks.length > 0 ? <Text style={styles.hint}>{blanksHint(blanks)}</Text> : null}

          {template ? (
            <View style={styles.chip}>
              <Text style={styles.chipText} numberOfLines={1}>{`Template: ${template.label}`}</Text>
              <Pressable
                onPress={() => setTemplate(null)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={`Remove the ${template.label} template`}
              >
                <Icon name="close" size={14} color={colors.ink} strokeWidth={2} />
              </Pressable>
            </View>
          ) : (
            <Pressable
              onPress={() => router.push("/build/templates")}
              disabled={starting}
              accessibilityRole="button"
              style={styles.templatesLink}
            >
              <Icon name="blocks" size={16} color={colors.ink} />
              <Text style={styles.templatesText}>{TEMPLATES_OPEN}</Text>
            </Pressable>
          )}

          <ZaviTextField
            title="Company name"
            containerStyle={styles.field}
            value={company}
            onChangeText={(t) => {
              setCompany(t);
              setError(null);
            }}
            maxLines={1}
            returnKeyType="done"
            submitBehavior="blurAndSubmit"
            maxLength={COMPANY_MAX_CHARS}
            placeholder="Your company"
            editable={!starting}
            accessibilityLabel="Company name"
          />
          {company.length > 0 && !companyCheck.ok ? <Text style={styles.hint}>{companyCheck.reason}</Text> : null}

          {wall ? (
            <View style={styles.wall}>
              <CreditWallNotice wall={wall} onDismiss={() => setWall(null)} />
            </View>
          ) : null}
          {error ? <Message tone="error">{error}</Message> : null}

          <PrimaryButton
            label={starting ? "Starting…" : "Start build"}
            onPress={() => void onStart()}
            disabled={!canStart}
          />
        </ScrollView>
      </KeyboardAvoider>
      <FullScreenLoader visible={starting} label="Starting your build…" />
    </Screen>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  flex: { flex: 1 },
  field: { marginTop: 16 },
  hint: {
    marginTop: space.xs,
    fontFamily: font.family.regular,
    fontSize: font.size.sm,
    lineHeight: 16,
    includeFontPadding: false,
    color: colors.muted,
  },
  chip: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    marginTop: space.md,
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: colors.soft,
  },
  chipText: { flexShrink: 1, fontFamily: font.family.medium, fontSize: font.size.sm, includeFontPadding: false, color: colors.ink },
  templatesLink: { alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: space.sm, marginTop: space.md, paddingVertical: space.xs },
  templatesText: { fontFamily: font.family.semi, fontSize: font.size.base, includeFontPadding: false, color: colors.ink, textDecorationLine: "underline" },
  wall: { marginHorizontal: -space.md, marginTop: space.md },
});
