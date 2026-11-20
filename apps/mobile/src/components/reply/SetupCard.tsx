import { useMemo, useState } from "react";
import { connectInfoFor } from "@zavi/shared";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { ApiFetchError } from "../../lib/api";
import {
  agentName,
  setupCanSave,
  setupPayload,
  type SetupModel,
} from "../../features/agents/replyCards";
import { submitSetup } from "../../features/agents/replyApi";
import { findConnectorRow, setupConnectorGate } from "../../features/connectors/connectPlan";
import { useConnectorRows } from "../../features/connectors/useConnectorRows";
import { ConnectControl } from "../connect/ConnectControl";
import { FocusRing } from "../ZaviTextField";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";
import { Card, CardButton, ErrorLine, errorText, makeUi } from "./ui";

const titleize = (slug: string) => slug.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export function SetupCard({
  slug,
  model,
  onRunStarted,
  busy = false,
  claimRun,
  releaseRun,
}: {
  slug: string;
  model: SetupModel;
  onRunStarted?: (runId: string) => void;
  busy?: boolean;
  claimRun?: () => boolean;
  releaseRun?: () => void;
}) {
  const styles = useStyles(makeStyles);
  const ui = useStyles(makeUi);
  const { colors, textSelectionColor, keyboardAppearance } = useTheme();
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runFailed, setRunFailed] = useState(false);
  const name = agentName(slug);
  const needsConnectors =
    model.missingRequiredConnectors.length + model.missingOptionalConnectors.length > 0;
  const { rows, failed, refresh } = useConnectorRows(needsConnectors && !saved);
  const stillMissing = useMemo(() => {
    const missing = (list: string[]) => list.filter((c) => !rows || !findConnectorRow(rows, c));
    return {
      required: missing(model.missingRequiredConnectors),
      optional: missing(model.missingOptionalConnectors),
    };
  }, [rows, model.missingRequiredConnectors, model.missingOptionalConnectors]);
  const gate = setupConnectorGate(model.missingRequiredConnectors, rows);
  const canSave = setupCanSave(model, values) && gate === "ready";

  async function save() {
    if (claimRun && !claimRun()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await submitSetup(slug, setupPayload(values));
      if (res?.retry && res.retry.ok === false) {
        setValues({});
        setRunFailed(true);
        setError(
          `Your keys are saved, but ${name} couldn't start` +
            (res.retry.error ? ` (${res.retry.error})` : "") +
            ". Send your message again to run it.",
        );
        return;
      }
      setValues({});
      setSaved(true);
      if (res?.retry?.run_id) onRunStarted?.(res.retry.run_id);
    } catch (e) {
      setError(
        e instanceof ApiFetchError && e.code === "owner_only"
          ? "Only the workspace owner can save these keys."
          : errorText(e, "Couldn't save. Please try again."),
      );
    } finally {
      setSaving(false);
      releaseRun?.();
    }
  }

  if (saved) {
    return (
      <Card>
        <Text style={ui.muted}>Setup saved. Running {name} now.</Text>
      </Card>
    );
  }

  return (
    <Card>
      <Text style={ui.title}>Setup needed before {name} can run</Text>
      {model.rationale ? <Text style={ui.muted}>{model.rationale}</Text> : null}

      {model.keys.map((k) => (
        <View key={k.key} style={styles.field}>
          <Text style={styles.label}>
            {k.label}
            {k.required ? <Text style={styles.required}> *</Text> : null}
          </Text>
          <FocusRing radius={radius.md}>
            {(focus) => (
              <TextInput
                keyboardAppearance={keyboardAppearance}
                value={values[k.key] ?? ""}
                onChangeText={(t) => setValues((v) => ({ ...v, [k.key]: t }))}
                placeholder={k.placeholder ?? ""}
                placeholderTextColor={colors.muted}
                selectionColor={textSelectionColor}
                cursorColor={colors.ink}
                selectionHandleColor={colors.ink}
                secureTextEntry={k.input === "password"}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                autoComplete="off"
                textContentType="none"
                importantForAutofill="no"
                keyboardType={k.input === "email" ? "email-address" : k.input === "url" ? "url" : "default"}
                style={styles.input}
                accessibilityLabel={k.label}
                onFocus={() => focus.onFocus()}
                onBlur={() => focus.onBlur()}
              />
            )}
          </FocusRing>
        </View>
      ))}

      {stillMissing.required.length > 0 ? (
        <View style={styles.connectors}>
          <Text style={styles.label}>Connect first</Text>
          {stillMissing.required.map((c) => (
            <ConnectorButton key={c} slug={c} onAttempted={refresh} />
          ))}
        </View>
      ) : null}
      {stillMissing.optional.length > 0 ? (
        <View style={styles.connectors}>
          <Text style={ui.small}>Recommended (optional)</Text>
          {stillMissing.optional.map((c) => (
            <ConnectorButton key={c} slug={c} variant="secondary" onAttempted={refresh} />
          ))}
        </View>
      ) : null}

      {gate === "loading" && failed ? (
        <View style={ui.row}>
          <Text style={ui.small}>Couldn't check your connections.</Text>
          <CardButton label="Try again" variant="plain" onPress={refresh} />
        </View>
      ) : null}

      <ErrorLine message={error} />

      <View style={ui.row}>
        <CardButton
          label={saving ? "Saving" : "Save and run"}
          busy={saving}
          disabled={!canSave || busy || runFailed}
          onPress={() => void save()}
        />
      </View>
    </Card>
  );
}

function ConnectorButton({
  slug,
  variant,
  onAttempted,
}: {
  slug: string;
  variant?: "primary" | "secondary";
  onAttempted: () => void;
}) {
  const ui = useStyles(makeUi);
  if (!connectInfoFor(slug)) return <Text style={ui.muted}>{titleize(slug)}</Text>;
  return <ConnectControl slug={slug} variant={variant} onAttempted={onAttempted} />;
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  field: { gap: 6 },
  label: { fontSize: 14, fontFamily: font.family.medium, color: colors.ink },
  required: { color: colors.red },
  input: {
    height: 44,
    paddingHorizontal: 12,
    fontSize: 15,
    fontFamily: font.family.medium,
    color: colors.ink,
  },
  connectors: { gap: space.sm, padding: space.md, borderRadius: radius.md, backgroundColor: colors.soft },
});
