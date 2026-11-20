import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { BottomSheetTextInput, useBottomSheetInternal } from "@gorhom/bottom-sheet";
import { FocusRing } from "../ZaviTextField";
import {
  connectFigma,
  connectOperatorDb,
  connectSentry,
  connectStripe,
  posthogConnect,
  posthogProjects,
  supabaseConnect,
  supabaseProjects,
  type DbType,
  type PosthogProject,
  type SentryProject,
  type SupabaseProject,
} from "../../features/connectors/api";
import { keyFormReady, probeFailureReason, type KeyFormKind } from "../../features/connectors/connectPlan";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";
import { track } from "../../lib/analytics";
import { errorText, makeUi } from "../reply/ui";
import { ErrorCard } from "../ErrorCard";

type FormProps = { slug: string; onConnected: () => void; onCancel: () => void };

export function KeyForm({ form, ...props }: FormProps & { form: KeyFormKind }) {
  switch (form) {
    case "stripe":
      return <StripeForm {...props} />;
    case "operator_db":
      return <OperatorDbForm {...props} />;
    case "posthog":
      return <PosthogForm {...props} />;
    case "sentry":
      return <SentryForm {...props} />;
    case "figma":
      return <FigmaForm {...props} />;
    case "supabase":
      return <SupabaseForm {...props} />;
  }
}

function useKeyInput(): typeof TextInput {
  return (useBottomSheetInternal(true) ? BottomSheetTextInput : TextInput) as typeof TextInput;
}

function SecretField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const styles = useStyles(makeStyles);
  const { colors, textSelectionColor, keyboardAppearance } = useTheme();
  const [show, setShow] = useState(false);
  const Input = useKeyInput();
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.secretRow}>
        <FocusRing radius={radius.sm} style={styles.secretInput}>
          {(focus) => (
            <Input
              keyboardAppearance={keyboardAppearance}
              value={value}
              onChangeText={onChange}
              placeholder={placeholder ?? ""}
              placeholderTextColor={colors.disabledText}
              selectionColor={textSelectionColor}
              cursorColor={colors.ink}
              selectionHandleColor={colors.ink}
              secureTextEntry={!show}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              autoComplete="off"
              textContentType="none"
              importantForAutofill="no"
              onFocus={focus.onFocus}
              onBlur={focus.onBlur}
              style={styles.input}
              accessibilityLabel={label}
            />
          )}
        </FocusRing>
        <Pressable
          style={({ pressed }) => [styles.showButton, pressed && styles.pressed]}
          onPress={() => setShow((v) => !v)}
          accessibilityRole="button"
          accessibilityLabel={`${show ? "Hide" : "Show"} ${label}`}
        >
          <Text style={styles.showText} numberOfLines={1}>
            {show ? "Hide" : "Show"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function PlainField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const styles = useStyles(makeStyles);
  const { colors, textSelectionColor, keyboardAppearance } = useTheme();
  const Input = useKeyInput();
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <FocusRing radius={radius.sm}>
        {(focus) => (
          <Input
            keyboardAppearance={keyboardAppearance}
            value={value}
            onChangeText={onChange}
            placeholder={placeholder ?? ""}
            placeholderTextColor={colors.disabledText}
            selectionColor={textSelectionColor}
            cursorColor={colors.ink}
            selectionHandleColor={colors.ink}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            autoComplete="off"
            onFocus={focus.onFocus}
            onBlur={focus.onBlur}
            style={styles.input}
            accessibilityLabel={label}
          />
        )}
      </FocusRing>
    </View>
  );
}

function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.choices}>
        {options.map((o) => {
          const on = o.value === value;
          return (
            <Pressable
              key={o.value}
              onPress={() => onChange(o.value)}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              style={[styles.choice, on && styles.choiceOn]}
            >
              <Text style={[styles.choiceText, on && styles.choiceTextOn]}>{o.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function Steps({ title, steps }: { title: string; steps: ReactNode[] }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.steps}>
      <Text style={styles.stepsTitle} accessibilityRole="header">
        {title}
      </Text>
      <View style={styles.stepsList}>
        {steps.map((s, i) => (
          <View key={i} style={styles.stepRow}>
            <Text style={styles.stepText}>{`${i + 1}.`}</Text>
            <Text style={[styles.stepText, styles.stepBody]}>{s}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function Note({ children }: { children: ReactNode }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.note}>
      <Text style={styles.noteText}>{children}</Text>
    </View>
  );
}

function FormButton({
  label,
  onPress,
  disabled,
  variant = "primary",
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: "primary" | "secondary";
}) {
  const styles = useStyles(makeStyles);
  const primary = variant === "primary";
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => [
        styles.button,
        primary ? styles.buttonPrimary : styles.buttonSecondary,
        disabled && styles.buttonOff,
        pressed && !disabled && styles.pressed,
      ]}
    >
      <Text style={[styles.buttonText, primary && styles.buttonTextPrimary]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

function Actions({
  label,
  busy,
  ready,
  onSubmit,
  onCancel,
}: {
  label: string;
  busy: boolean;
  ready: boolean;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.actions}>
      <FormButton label="Cancel" variant="secondary" disabled={busy} onPress={onCancel} />
      <FormButton label={busy ? "Checking" : label} disabled={!ready || busy} onPress={onSubmit} />
    </View>
  );
}

function SuccessPanel({ title, children, onDone }: { title: string; children: ReactNode; onDone: () => void }) {
  const styles = useStyles(makeStyles);
  const ui = useStyles(makeUi);
  return (
    <View style={styles.form}>
      <Text style={ui.title}>{title}</Text>
      <Text style={ui.muted}>{children}</Text>
      <View style={styles.actions}>
        <FormButton label="Done" onPress={onDone} />
      </View>
    </View>
  );
}

function useSubmit(fallback: string, title?: string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(fn: () => Promise<void>, onError?: () => void) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      onError?.();
      const message = title ? errorText(e, "") : "";
      setError(message ? `${title}: ${message}` : errorText(e, fallback));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, setError, run };
}

function StripeForm({ slug, onConnected, onCancel }: FormProps) {
  const styles = useStyles(makeStyles);
  const ui = useStyles(makeUi);
  const [apiKey, setApiKey] = useState("");
  const s = useSubmit("Couldn't connect Stripe. Please try again.");
  const ready = keyFormReady("stripe", { api_key: apiKey });
  return (
    <View style={styles.form}>
      <Steps
        title="How to connect Stripe (~2 min)"
        steps={[
          "Open dashboard.stripe.com/apikeys and click Create secret key, then Powering an integration you built.",
          "Name it Zavi. Under Permissions, set every resource to Read, then change Disputes to Write.",
          "Click Create key, copy it (it starts with rk_) and paste it below.",
        ]}
      />
      <SecretField label="Paste your restricted key" value={apiKey} onChange={setApiKey} placeholder="rk_live_..." />
      <Text style={ui.small}>
        Nothing here can move money or issue refunds. We verify the key with Stripe before saving; it is
        stored encrypted and never logged.
      </Text>
      {s.error ? <ErrorCard message={s.error} /> : null}
      <Actions
        label="Connect Stripe"
        busy={s.busy}
        ready={ready}
        onCancel={() => {
          setApiKey("");
          onCancel();
        }}
        onSubmit={() =>
          void s.run(async () => {
            track("connector_connect_started", { slug, method: "key" });
            await connectStripe(apiKey);
            track("connector_connected", { slug });
            setApiKey("");
            onConnected();
          }, () => track("connector_connect_failed", { slug }))
        }
      />
    </View>
  );
}

const DB_TYPES: { value: DbType; label: string }[] = [
  { value: "postgres", label: "Postgres" },
  { value: "mongodb", label: "MongoDB" },
  { value: "mysql", label: "MySQL" },
  { value: "dynamodb", label: "DynamoDB" },
];

const DB_PLACEHOLDER: Record<DbType, string> = {
  postgres: "postgres://user:pass@host:5432/db",
  mongodb: "mongodb://user:pass@host:27017/db",
  mysql: "mysql://user:pass@host:3306/db",
  dynamodb: "dynamodb://access_key:secret_key@us-east-1",
};

function OperatorDbForm({ slug, onConnected, onCancel }: FormProps) {
  const styles = useStyles(makeStyles);
  const ui = useStyles(makeUi);
  const [type, setType] = useState<DbType>("postgres");
  const [connectionString, setConnectionString] = useState("");
  const s = useSubmit("Couldn't save. Please try again.");
  const ready = keyFormReady("operator_db", { connection_string: connectionString });
  return (
    <View style={styles.form}>
      <Choice label="DB type" value={type} options={DB_TYPES} onChange={setType} />
      <SecretField
        label="Connection string"
        value={connectionString}
        onChange={setConnectionString}
        placeholder={DB_PLACEHOLDER[type]}
      />
      <Text style={ui.small}>
        Stored encrypted in Vault. Never logged. Use a read-only user: Zavi only reads.
      </Text>
      {s.error ? <ErrorCard message={s.error} /> : null}
      <Actions
        label="Connect & detect schema"
        busy={s.busy}
        ready={ready}
        onCancel={() => {
          setConnectionString("");
          onCancel();
        }}
        onSubmit={() =>
          void s.run(async () => {
            track("connector_connect_started", { slug, method: "key" });
            const res = await connectOperatorDb(type, connectionString);
            if (res.ok) {
              track("connector_connected", { slug });
              setConnectionString("");
              onConnected();
              return;
            }
            track("connector_connect_failed", { slug });
            const reason = probeFailureReason(res.discovery_error);
            s.setError(
              `Couldn't connect to your database. ${reason ? `${reason} ` : ""}Check the host, port and credentials, then try again. Nothing was saved.`,
            );
          }, () => track("connector_connect_failed", { slug }))
        }
      />
    </View>
  );
}

function PosthogForm({ slug, onConnected, onCancel }: FormProps) {
  const styles = useStyles(makeStyles);
  const ui = useStyles(makeUi);
  const [apiKey, setApiKey] = useState("");
  const [region, setRegion] = useState<"us" | "eu">("us");
  const [projects, setProjects] = useState<PosthogProject[] | null>(null);
  const [projectId, setProjectId] = useState("");
  const [done, setDone] = useState<{ project: string } | null>(null);
  const s = useSubmit("Couldn't connect PostHog. Please try again.", "Couldn't connect PostHog");
  const picking = !!projects && projects.length > 1;

  async function connect(id: string, list: PosthogProject[]) {
    await posthogConnect(apiKey, region, id);
    track("connector_connected", { slug });
    setApiKey("");
    setDone({ project: list.find((p) => p.id === id)?.name ?? id });
  }

  if (done) {
    return (
      <SuccessPanel title="Connected to PostHog" onDone={onConnected}>
        Reading from <Text style={styles.strong}>{done.project}</Text>. Your agents can now answer funnel,
        activation and retention questions from real events.
      </SuccessPanel>
    );
  }

  return (
    <View style={styles.form}>
      <Steps
        title="How to connect PostHog (~1 min)"
        steps={[
          "In PostHog, open Settings → Personal API keys and create a key.",
          "Give it the Query Read and Project Read scopes. Those two are all we use — this connector never writes to PostHog.",
          "Paste the key below and pick the region your PostHog account is in. If the key reaches more than one project, choose the one to connect.",
        ]}
      />
      <SecretField
        label="Personal API key"
        value={apiKey}
        onChange={(v) => {
          setApiKey(v);
          setProjects(null);
          setProjectId("");
        }}
        placeholder="phx_..."
      />
      <Choice
        label="Region"
        value={region}
        options={[
          { value: "us", label: "US cloud (us.posthog.com)" },
          { value: "eu", label: "EU cloud (eu.posthog.com)" },
        ]}
        onChange={(r) => {
          setRegion(r);
          setProjects(null);
          setProjectId("");
        }}
      />
      {picking ? (
        <Choice
          label="Project"
          value={projectId}
          options={projects.map((p) => ({ value: p.id, label: p.name }))}
          onChange={setProjectId}
        />
      ) : null}
      <Text style={ui.small}>
        Read-only. Agents run analytics queries against this project and never write to it.
      </Text>
      {s.error ? <ErrorCard message={s.error} /> : null}
      <Actions
        label={picking ? "Connect project" : "Connect"}
        busy={s.busy}
        ready={keyFormReady("posthog", { api_key: apiKey }) && (!picking || !!projectId)}
        onCancel={() => {
          setApiKey("");
          onCancel();
        }}
        onSubmit={() =>
          void s.run(async () => {
            track("connector_connect_started", { slug, method: "key" });
            if (projects && projectId) return connect(projectId, projects);
            const list = await posthogProjects(apiKey, region);
            if (list.length === 1) return connect(list[0].id, list);
            if (list.length === 0) {
              track("connector_connect_failed", { slug });
              s.setError("That key can't reach any PostHog project.");
              return;
            }
            setProjects(list);
            setProjectId("");
          }, () => track("connector_connect_failed", { slug }))
        }
      />
    </View>
  );
}

function SentryForm({ slug, onConnected, onCancel }: FormProps) {
  const styles = useStyles(makeStyles);
  const ui = useStyles(makeUi);
  const [authToken, setAuthToken] = useState("");
  const [orgSlug, setOrgSlug] = useState("");
  const [done, setDone] = useState<{ org: string; projects: SentryProject[] } | null>(null);
  const s = useSubmit("Couldn't connect Sentry. Please try again.", "Couldn't connect Sentry");
  if (done) {
    return (
      <SuccessPanel title="Connected to Sentry" onDone={onConnected}>
        Reading from <Text style={styles.strong}>{done.org}</Text>
        {done.projects.length > 0 ? (
          <>
            {" "}
            ({done.projects.length} project{done.projects.length === 1 ? "" : "s"} visible). Your agents can now read issues
            and error volume when they investigate a regression.
          </>
        ) : (
          <>. Your agents can now read issues when they investigate a regression.</>
        )}
      </SuccessPanel>
    );
  }
  return (
    <View style={styles.form}>
      <Steps
        title="How to connect Sentry (~1 min)"
        steps={[
          "In Sentry, open Settings → Auth Tokens and create an organization token.",
          "Give it org:read, project:read and event:read. Those three are all we use; this connector never writes to Sentry.",
          "Paste it below with your organization slug (the part after sentry.io/organizations/).",
        ]}
      />
      <SecretField label="Auth token" value={authToken} onChange={setAuthToken} placeholder="sntrys_..." />
      <PlainField label="Organization slug" value={orgSlug} onChange={setOrgSlug} placeholder="acme-inc" />
      <Text style={ui.small}>
        Read-only. Agents read issues, events and error volume; nothing is created, resolved or deleted in your Sentry.
      </Text>
      {s.error ? <ErrorCard message={s.error} /> : null}
      <Actions
        label="Connect"
        busy={s.busy}
        ready={keyFormReady("sentry", { auth_token: authToken, org_slug: orgSlug })}
        onCancel={() => {
          setAuthToken("");
          onCancel();
        }}
        onSubmit={() =>
          void s.run(async () => {
            track("connector_connect_started", { slug, method: "key" });
            const res = await connectSentry(authToken, orgSlug);
            track("connector_connected", { slug });
            setAuthToken("");
            setDone({ org: res.org_slug ?? orgSlug, projects: res.projects ?? [] });
          }, () => track("connector_connect_failed", { slug }))
        }
      />
    </View>
  );
}

function FigmaForm({ slug, onConnected, onCancel }: FormProps) {
  const styles = useStyles(makeStyles);
  const [apiKey, setApiKey] = useState("");
  const [done, setDone] = useState<{ handle: string | null } | null>(null);
  const s = useSubmit("Couldn't connect Figma. Please try again.", "Couldn't connect Figma");
  if (done) {
    return (
      <SuccessPanel title="Connected to Figma" onDone={onConnected}>
        {done.handle ? (
          <>
            Connected as <Text style={styles.strong}>{done.handle}</Text>. Your agents can now read the files and projects
            this account can open.
          </>
        ) : (
          <>Your agents can now read the files and projects this account can open.</>
        )}
      </SuccessPanel>
    );
  }
  return (
    <View style={styles.form}>
      <Steps
        title="How to connect Figma (~1 min)"
        steps={[
          <>
            In Figma, open <Text style={styles.strong}>Settings → Security → Personal access tokens</Text> and generate a
            token.
          </>,
          <>
            Grant <Text style={styles.strong}>current_user:read</Text>,{" "}
            <Text style={styles.strong}>file_content:read</Text> and <Text style={styles.strong}>projects:read</Text>.
            Those three are all we use.
          </>,
          "Paste it below. We check it against your account before saving it.",
        ]}
      />
      <SecretField label="Personal access token" value={apiKey} onChange={setApiKey} placeholder="figd_…" />
      <Note>
        Read-only. Agents read file contents and project lists; nothing is edited, commented on or published in your Figma.
      </Note>
      {s.error ? <ErrorCard message={s.error} /> : null}
      <Actions
        label="Connect"
        busy={s.busy}
        ready={keyFormReady("figma", { api_key: apiKey })}
        onCancel={() => {
          setApiKey("");
          onCancel();
        }}
        onSubmit={() =>
          void s.run(async () => {
            track("connector_connect_started", { slug, method: "key" });
            const res = await connectFigma(apiKey);
            track("connector_connected", { slug });
            setApiKey("");
            setDone({ handle: res.handle ?? null });
          }, () => track("connector_connect_failed", { slug }))
        }
      />
    </View>
  );
}

function SupabaseForm({ slug, onConnected, onCancel }: FormProps) {
  const styles = useStyles(makeStyles);
  const ui = useStyles(makeUi);
  const [accessToken, setAccessToken] = useState("");
  const [projects, setProjects] = useState<SupabaseProject[] | null>(null);
  const [projectRef, setProjectRef] = useState("");
  const [done, setDone] = useState<{ project: string } | null>(null);
  const s = useSubmit("Couldn't connect Supabase. Please try again.", "Couldn't connect Supabase");
  const picking = !!projects && projects.length > 1;

  async function connect(ref: string, list: SupabaseProject[]) {
    const res = await supabaseConnect(accessToken, ref);
    track("connector_connected", { slug });
    setAccessToken("");
    setDone({ project: res.project_name ?? list.find((p) => p.ref === ref)?.name ?? ref });
  }

  if (done) {
    return (
      <SuccessPanel title="Connected to Supabase" onDone={onConnected}>
        Reading from <Text style={styles.strong}>{done.project}</Text>. Every agent call is pinned to this project.
      </SuccessPanel>
    );
  }

  return (
    <View style={styles.form}>
      <Steps
        title="How to connect Supabase (~1 min)"
        steps={[
          "Open supabase.com/dashboard/account/tokens and generate a personal access token.",
          "Paste it below. We check it against your account before saving it.",
          "Pick the project agents may read. Supabase tokens are account-scoped, so this pick is what limits us to one project.",
        ]}
      />
      <SecretField
        label="Personal access token"
        value={accessToken}
        onChange={(v) => {
          setAccessToken(v);
          setProjects(null);
          setProjectRef("");
        }}
        placeholder="sbp_..."
      />
      {picking ? (
        <Choice
          label="Project"
          value={projectRef}
          options={projects.map((p) => ({ value: p.ref, label: `${p.name} (${p.region})` }))}
          onChange={setProjectRef}
        />
      ) : null}
      <Text style={ui.small}>
        Read-only. Agents read project metadata, edge functions and analytics; nothing in your database is written or migrated.
      </Text>
      {s.error ? <ErrorCard message={s.error} /> : null}
      <Actions
        label={picking ? "Connect project" : "Connect"}
        busy={s.busy}
        ready={keyFormReady("supabase", { access_token: accessToken })}
        onCancel={() => {
          setAccessToken("");
          onCancel();
        }}
        onSubmit={() =>
          void s.run(async () => {
            track("connector_connect_started", { slug, method: "key" });
            if (projects && projectRef) return connect(projectRef, projects);
            const list = await supabaseProjects(accessToken);
            if (list.length === 1) return connect(list[0].ref, list);
            if (list.length === 0) {
              track("connector_connect_failed", { slug });
              s.setError("That token can't reach any Supabase project.");
              return;
            }
            setProjects(list);
            setProjectRef(list[0].ref);
          }, () => track("connector_connect_failed", { slug }))
        }
      />
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  form: {
    gap: space.lg,
    padding: space.lg,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.lg,
    backgroundColor: colors.panel,
  },
  steps: {
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    backgroundColor: colors.soft,
  },
  stepsTitle: { includeFontPadding: false, fontSize: 16, lineHeight: 22, fontFamily: font.family.semi, color: colors.ink },
  stepsList: { gap: space.sm },
  stepRow: { flexDirection: "row", gap: 6 },
  stepText: { fontSize: font.size.md, lineHeight: 18, fontFamily: font.family.regular, color: colors.muted },
  stepBody: { flex: 1 },
  note: {
    paddingHorizontal: space.md,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.sm,
    backgroundColor: colors.soft,
  },
  noteText: { fontSize: font.size.md, lineHeight: 17, fontFamily: font.family.regular, color: colors.muted },
  field: { gap: space.sm },
  label: { fontSize: 14, lineHeight: 20, fontFamily: font.family.medium, color: colors.muted },
  input: {
    height: 48,
    paddingHorizontal: space.md,
    paddingVertical: 0,
    includeFontPadding: false,
    textAlignVertical: "center",
    fontSize: 15,
    fontFamily: font.family.medium,
    color: colors.ink,
  },
  secretRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  secretInput: { flex: 1 },
  showButton: {
    height: 48,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: colors.wire.line,
    borderRadius: radius.pill,
    backgroundColor: colors.panel,
  },
  showText: { includeFontPadding: false, fontSize: 14, fontFamily: font.family.semi, color: colors.wire.strong },
  actions: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: space.sm },
  button: {
    height: 48,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
    borderRadius: radius.pill,
  },
  buttonPrimary: { backgroundColor: colors.wire.ink },
  buttonSecondary: { borderWidth: 1, borderColor: colors.wire.line, backgroundColor: colors.panel },
  buttonOff: { opacity: 0.55 },
  buttonText: { includeFontPadding: false, fontSize: 14, fontFamily: font.family.semi, color: colors.wire.strong },
  buttonTextPrimary: { color: colors.onInk },
  pressed: { opacity: 0.55 },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  choice: {
    minHeight: 34,
    justifyContent: "center",
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.sm,
    backgroundColor: colors.panel,
  },
  choiceOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  choiceText: { fontSize: font.size.md, fontFamily: font.family.medium, color: colors.ink },
  choiceTextOn: { color: colors.onInk },
  strong: { fontFamily: font.family.semi, color: colors.ink },
});
