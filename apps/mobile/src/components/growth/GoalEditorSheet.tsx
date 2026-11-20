import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { ApiFetchErrorLike } from "./goalEditorTypes";
import {
  CUSTOM_METRIC,
  PAUSE_ERROR,
  buildGoalPayload,
  currentRequired,
  dataSourceNote,
  effectiveMetric,
  goalFieldsStart,
  liveReadLine,
  MANUAL_NUMBER_NOTE,
  saveErrorText,
  serverMessage,
  validateFields,
  type GoalFields,
  type GoalFormErrors,
} from "../../features/growth/goalForm";
import { useEditorLiveRead, usePauseGoal, useSaveGoal } from "../../features/growth/hooks";
import { GOAL_METRIC_OPTIONS, dataSourceForMetric, type GrowthGoal } from "../../features/growth/plan";
import { track } from "../../lib/analytics";
import { font, space, type Colors } from "../../theme/tokens";
import { useStyles } from "../../theme/theme";
import { AppBottomSheet } from "../AppBottomSheet";
import { DateField, Field, FieldError, FieldHint, PickerField, SheetInput } from "./SheetFields";
import { GoalHistoryView } from "./GoalHistoryView";
import { ActionButton, ErrorLine, TextLink } from "./StoryKit";

const METRIC_OPTIONS = [
  ...GOAL_METRIC_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
  { value: CUSTOM_METRIC, label: "Something else…" },
];

export function GoalEditorSheet({
  goal,
  initialObjective,
  onClose,
  onAsk,
}: {
  goal: GrowthGoal | null;
  initialObjective?: string;
  onClose: () => void;
  onAsk: (text: string) => void;
}) {
  const styles = useStyles(makeStyles);
  const isEdit = goal !== null;
  const save = useSaveGoal();
  const pause = usePauseGoal();
  const [fields, setFields] = useState<GoalFields>(() => goalFieldsStart(goal, initialObjective));
  const [errors, setErrors] = useState<GoalFormErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [pulled, setPulled] = useState<number | null>(null);

  const metric = effectiveMetric(fields);
  const source = dataSourceForMetric(metric);
  const required = currentRequired(metric);
  const live = useEditorLiveRead(metric, !!metric && source.automatic, source.label);
  const busy = save.isPending || pause.isPending;

  const set = (patch: Partial<GoalFields>, clear?: keyof GoalFormErrors) => {
    setFields((f) => ({ ...f, ...patch }));
    setServerError(null);
    if (clear) setErrors((e) => (e[clear] ? { ...e, [clear]: undefined } : e));
  };
  const validateOne = (field: keyof GoalFormErrors, next: GoalFields = fields) =>
    setErrors((e) => ({ ...e, [field]: validateFields(next)[field] }));

  const submit = async () => {
    if (busy) return;
    if (warning) return onClose();
    const found = validateFields(fields);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setServerError(null);
    try {
      const warnings = await save.mutateAsync({ id: goal?.id ?? null, payload: buildGoalPayload({ fields, goal, pulledValue: pulled }) });
      track("growth_goal_saved");
      if (warnings.length > 0) setWarning(warnings.join(" "));
      else onClose();
    } catch (e) {
      setServerError(saveErrorText(e as ApiFetchErrorLike));
    }
  };

  const pauseGoal = async () => {
    if (busy || !goal) return;
    setServerError(null);
    try {
      await pause.mutateAsync(goal.id);
      onClose();
    } catch (e) {
      setServerError(serverMessage(e as ApiFetchErrorLike, PAUSE_ERROR));
    }
  };

  const read = live ? liveReadLine(live, metric, source) : null;

  const footer = (
    <View style={styles.actions}>
      {isEdit && goal?.status === "active" ? <ActionButton label="Pause goal" variant="secondary" disabled={busy} onPress={() => void pauseGoal()} /> : null}
      <View style={styles.row}>
        <ActionButton label="Cancel" variant="secondary" grow disabled={busy} onPress={onClose} />
        <ActionButton
          label={warning ? "Done" : isEdit ? "Save changes" : "Save"}
          grow
          busy={save.isPending}
          busyLabel="Saving…"
          onPress={() => void submit()}
        />
      </View>
    </View>
  );

  return (
    <AppBottomSheet open onClose={onClose} title={isEdit ? "Edit goal" : "Create goal"} locked={busy} footer={footer}>
      <Text style={styles.intro}>Set a clear outcome and the number that defines success.</Text>

      <Field label="Goal name" required>
        <SheetInput
          label="Goal name"
          value={fields.objective}
          onChange={(v) => set({ objective: v }, "objective")}
          onBlur={() => validateOne("objective")}
          placeholder="e.g. Reach $100K MRR"
          maxLength={500}
          invalid={!!errors.objective}
        />
        <FieldError>{errors.objective}</FieldError>
      </Field>

      <Field label="Metric" required>
        <PickerField
          label="Metric"
          value={fields.metricChoice}
          options={METRIC_OPTIONS}
          placeholder="Select a metric"
          invalid={!!errors.metric && fields.metricChoice !== CUSTOM_METRIC}
          onChange={(v) => {
            const next = { ...fields, metricChoice: v };
            set({ metricChoice: v }, "metric");
            setPulled(null);
            if (v !== CUSTOM_METRIC) validateOne("metric", next);
          }}
        />
        {fields.metricChoice !== CUSTOM_METRIC ? <FieldError>{errors.metric}</FieldError> : null}
      </Field>

      {fields.metricChoice === CUSTOM_METRIC ? (
        <Field label="Metric name" required>
          <SheetInput
            label="Metric name"
            value={fields.customMetric}
            onChange={(v) => {
              set({ customMetric: v }, "metric");
              setPulled(null);
            }}
            onBlur={() => validateOne("metric")}
            placeholder="e.g. Verified hosts"
            maxLength={120}
            invalid={!!errors.metric}
          />
          <FieldError>{errors.metric}</FieldError>
        </Field>
      ) : null}

      <Field label="Data source">
        <SheetInput label="Data source" value={metric ? source.label : "Select a metric first"} onChange={() => {}} readOnly />
        <FieldHint>{dataSourceNote(metric)}</FieldHint>
      </Field>

      <Field label="Current value" required={required}>
        <SheetInput
          label="Current value"
          value={fields.currentValue}
          onChange={(v) => set({ currentValue: v }, "currentValue")}
          onBlur={() => validateOne("currentValue")}
          placeholder={!metric ? "Select a metric first" : undefined}
          numeric
          invalid={!!errors.currentValue}
        />
        <FieldError>{errors.currentValue}</FieldError>
        {source.automatic && read ? (
          <View style={styles.readRow}>
            <Text style={styles.hint}>{read.text}</Text>
            {read.use && live?.value !== undefined ? (
              <TextLink
                label="Use it"
                onPress={() => {
                  const v = live.value as number;
                  set({ currentValue: String(v) }, "currentValue");
                  setPulled(v);
                }}
              />
            ) : null}
          </View>
        ) : required ? (
          <FieldHint>{MANUAL_NUMBER_NOTE}</FieldHint>
        ) : null}
      </Field>

      <Field label="Target value" required>
        <SheetInput
          label="Target value"
          value={fields.targetValue}
          onChange={(v) => set({ targetValue: v }, "targetValue")}
          onBlur={() => validateOne("targetValue")}
          placeholder="100000"
          numeric
          invalid={!!errors.targetValue}
        />
        <FieldError>{errors.targetValue}</FieldError>
      </Field>

      <Field label="Due date" required>
        <DateField
          label="Due date"
          value={fields.dueDate}
          onChange={(v) => set({ dueDate: v }, "dueDate")}
          invalid={!!errors.dueDate}
        />
        <FieldError>{errors.dueDate}</FieldError>
      </Field>

      {serverError ? <ErrorLine>{serverError}</ErrorLine> : null}
      {warning ? <ErrorLine>{warning}</ErrorLine> : null}
      {isEdit && goal ? <GoalHistoryView goal={goal} onAsk={onAsk} /> : null}
    </AppBottomSheet>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    intro: { fontFamily: font.family.regular, fontSize: 14, lineHeight: 20, includeFontPadding: false, color: colors.textSecondary, marginBottom: space.lg },
    readRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", gap: 4 },
    hint: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, includeFontPadding: false, color: colors.textSecondary },
    actions: { gap: space.md, marginTop: space.sm },
    row: { flexDirection: "row", gap: space.md },
  });
