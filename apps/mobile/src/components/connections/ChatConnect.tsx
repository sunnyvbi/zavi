import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Clipboard,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { BottomSheetTextInput } from "@gorhom/bottom-sheet";
import { ApiFetchError, apiFetch, apiJson } from "../../lib/api";
import { ErrorLine } from "../reply/ui";
import { ConfirmDialog } from "../ConfirmDialog";
import { Icon } from "../Icon";
import { UnderlinedText } from "../UnderlinedText";
import { FocusRing, ZaviTextField } from "../ZaviTextField";
import { teamsBindError } from "../../features/connectors/messaging";
import type { WhatsAppHandset } from "../../features/connectors/useConnections";
import { font, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

const BASE_ERRORS: Record<string, string> = {
  unauthenticated: "Your session expired. Sign in again and try again.",
  no_active_tenant: "No active workspace on this session. Try again.",
  membership_revoked: "You're no longer a member of this workspace.",
  auth_db_error: "Couldn't verify your session. Try again in a moment.",
  forbidden: "Only an owner or admin can connect this.",
  link_mint_failed: "Couldn't create a connect link. Try again.",
};

const POLL_MS = 3000;
const POLL_WINDOW_MS = 15 * 60 * 1000;

function expiresLabel(expiresIn?: number): string {
  const min = typeof expiresIn === "number" && expiresIn > 0 ? Math.max(1, Math.floor(expiresIn / 60)) : 15;
  return `Expires in ${min} minute${min === 1 ? "" : "s"}.`;
}

function errorFrom(e: unknown, errors: Record<string, string>, fallback: string): string {
  const code = e instanceof ApiFetchError ? e.code : "";
  if (e instanceof ApiFetchError && e.status === 401 && (code === "http_401" || !code)) {
    return BASE_ERRORS.unauthenticated;
  }
  return errors[code] ?? BASE_ERRORS[code] ?? fallback;
}

function serverMessageFrom(e: unknown): string | null {
  if (!(e instanceof ApiFetchError)) return null;
  const generic = `Request failed (${e.status})`;
  return e.message && e.message !== generic ? e.message : null;
}

function statusErrorFrom(e: unknown, errors: Record<string, string>): string {
  if (e instanceof ApiFetchError) {
    const code = e.code;
    if (e.status === 401) return BASE_ERRORS.unauthenticated;
    return (
      errors[code] ??
      BASE_ERRORS[code] ??
      `Couldn't check the connection (HTTP ${e.status}). Try again.`
    );
  }
  return "Couldn't check the connection (network). Try again.";
}

type Step = "linking" | "idle" | "wait" | "checking";

function useLinkFlow<T>(opts: {
  linkPath: string;
  statusPath: string;
  errors: Record<string, string>;
  accept: (json: T) => boolean;
  onConnected: () => void;
  autoStart?: boolean;
}) {
  const autoStart = opts.autoStart ?? true;
  const [step, setStep] = useState<Step>(autoStart ? "linking" : "idle");
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notYet, setNotYet] = useState(false);
  const baseline = useRef<{ connected: boolean; chats: number } | null>(null);
  const alive = useRef(true);
  const { linkPath, statusPath, errors, accept } = opts;
  const onConnected = useRef(opts.onConnected);
  onConnected.current = opts.onConnected;

  const readStatus = useCallback(() => apiJson<{ connected?: boolean; chats?: number }>(statusPath), [statusPath]);

  const startLink = useCallback(
    async (fresh: boolean) => {
      setError(null);
      setNotYet(false);
      setStep("linking");
      try {
        baseline.current = null;
        try {
          const pre = await readStatus();
          baseline.current = { connected: !!pre?.connected, chats: pre?.chats ?? 0 };
        } catch {
        }
        if (!alive.current) return;
        const json = await apiJson<T>(linkPath, { method: "POST", body: JSON.stringify(fresh ? { fresh: true } : {}) });
        if (!alive.current) return;
        if (!accept(json)) throw new Error("Couldn't create a connect link.");
        setData(json);
        setStep("wait");
      } catch (e) {
        if (!alive.current) return;
        setError(errorFrom(e, errors, "Couldn't create a connect link."));
        setStep("idle");
      }
    },
    [accept, errors, linkPath, readStatus],
  );

  async function checkConnected() {
    setError(null);
    setNotYet(false);
    setStep("checking");
    try {
      const json = await readStatus();
      if (json?.connected) {
        onConnected.current();
        return;
      }
      setNotYet(true);
    } catch (e) {
      setError(statusErrorFrom(e, errors));
    }
    setStep("wait");
  }

  const autoStarted = useRef(false);
  useEffect(() => {
    alive.current = true;
    if (autoStart && !autoStarted.current) {
      autoStarted.current = true;
      void startLink(false);
    }
    return () => {
      alive.current = false;
    };
  }, [autoStart, startLink]);

  useEffect(() => {
    if (!data) return;
    const startedAt = Date.now();
    let stopped = false;
    let inFlight = false;
    const id = setInterval(async () => {
      if (stopped || inFlight) return;
      if (Date.now() - startedAt >= POLL_WINDOW_MS) {
        stopped = true;
        clearInterval(id);
        return;
      }
      inFlight = true;
      try {
        const json = await readStatus();
        if (stopped) return;
        const now = { connected: !!json?.connected, chats: json?.chats ?? 0 };
        const base = baseline.current;
        if (base === null) {
          baseline.current = now;
          return;
        }
        if (now.connected && (!base.connected || now.chats > base.chats)) {
          stopped = true;
          clearInterval(id);
          onConnected.current();
        }
      } catch {
      } finally {
        inFlight = false;
      }
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [data, readStatus]);

  return { step, data, error, notYet, startLink, checkConnected };
}

const TELEGRAM_ERRORS: Record<string, string> = {
  telegram_disabled: "Telegram isn't configured on this workspace yet.",
  telegram_username_missing: "Telegram isn't fully configured on this workspace yet.",
  forbidden: "Only an owner or admin can connect Telegram.",
  link_mint_failed: "Couldn't create a connect link. Try again.",
};
type TelegramLink = { dm_url?: string; group_url?: string; expires_in?: number };
const telegramAccept = (j: TelegramLink) => !!j?.dm_url && !!j?.group_url;

export function TelegramConnect({ onConnected, autoStart = true }: { onConnected: () => void; autoStart?: boolean }) {
  const styles = useStyles(makeStyles);
  const f = useLinkFlow<TelegramLink>({
    linkPath: "/api/connectors/telegram/link",
    statusPath: "/api/connectors/telegram/status",
    errors: TELEGRAM_ERRORS,
    accept: telegramAccept,
    onConnected,
    autoStart,
  });
  return (
    <Card title="Connect Telegram" blurb="Tap a link from the Telegram account you want to connect." error={f.error}>
      {f.step === "linking" || f.step === "idle" ? (
        <Mint
          busy={f.step === "linking"}
          label={autoStart ? "Try again" : "Connect"}
          busyLabel="Creating link…"
          onPress={() => void f.startLink(true)}
        />
      ) : (
        <>
          <StepTitle>1. Open one of these in Telegram</StepTitle>
          <View style={styles.buttons}>
            <Primary
              label="Connect my DM"
              onPress={() => void Linking.openURL(f.data?.dm_url ?? "")}
              style={[styles.rowButton, styles.telegramPrimary]}
              textStyle={styles.telegramPrimaryText}
            />
            <Secondary
              label="Connect a group"
              onPress={() => void Linking.openURL(f.data?.group_url ?? "")}
              style={[styles.rowButton, styles.telegramSecondary]}
              textStyle={styles.telegramSecondaryText}
            />
          </View>
          <Note>
            {`One link, one chat, single use. ${expiresLabel(f.data?.expires_in)} In a group the bot only answers when @mentioned or replied to.`}
          </Note>
          <Check
            n={2}
            title="Come back here once Telegram says “Connected”"
            checkLabel="I've tapped it"
            checking={f.step === "checking"}
            onCheck={() => void f.checkConnected()}
            onRemint={() => void f.startLink(true)}
            notYet={f.notYet}
            notYetText="Not connected yet. Tap the link in Telegram first, then try again. If Telegram said the link expired, get a new one."
          />
        </>
      )}
    </Card>
  );
}

const DISCORD_ERRORS: Record<string, string> = {
  discord_disabled: "Discord isn't configured on this workspace yet.",
  forbidden: "Only an owner or admin can connect Discord.",
  link_mint_failed: "Couldn't create a connect code. Try again.",
};
type DiscordLink = { connect_command?: string; install_url?: string | null; expires_in?: number };
const discordAccept = (j: DiscordLink) => !!j?.connect_command;

export function DiscordConnect({ onConnected, autoStart = true }: { onConnected: () => void; autoStart?: boolean }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const f = useLinkFlow<DiscordLink>({
    linkPath: "/api/connectors/discord/link",
    statusPath: "/api/connectors/discord/status",
    errors: DISCORD_ERRORS,
    accept: discordAccept,
    onConnected,
    autoStart,
  });
  const [copied, setCopied] = useState(false);
  const command = f.data?.connect_command ?? "";
  const installUrl = f.data?.install_url ?? null;
  return (
    <Card title="Connect Discord" blurb="Add the bot, then post the code in your server." error={f.error}>
      {f.step === "linking" || f.step === "idle" ? (
        <Mint
          busy={f.step === "linking"}
          label={autoStart ? "Try again" : "Connect"}
          busyLabel="Creating code…"
          onPress={() => void f.startLink(true)}
        />
      ) : (
        <>
          <StepTitle>1. Add the Zavi bot to your server</StepTitle>
          {installUrl ? (
            <Pressable
              style={({ pressed }) => [styles.discordButton, pressed && styles.dim]}
              onPress={() => void Linking.openURL(installUrl)}
              accessibilityRole="button"
            >
              <Text style={styles.discordButtonText} numberOfLines={1}>
                Add to Discord
              </Text>
            </Pressable>
          ) : null}
          <Note>
            {installUrl
              ? "Skip this if the bot is already in the server."
              : "Ask your workspace admin for the bot install link if it isn't in the server yet."}
          </Note>
          <StepTitle>2. Post this in any channel of that server</StepTitle>
          <View style={styles.codeRow}>
            <Text style={styles.code} selectable numberOfLines={2}>
              {command}
            </Text>
            <Pressable
              style={({ pressed }) => [styles.copyIcon, pressed && styles.dim]}
              onPress={() => {
                Clipboard.setString(command);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel={copied ? "Copied" : "Copy code"}
            >
              <Icon
                name={copied ? "check" : "copy"}
                size={18}
                color={copied ? colors.status.greenStrong : colors.wire.strong}
              />
            </Pressable>
          </View>
          <Note>
            {`Pick the @Zavi entry with the APP badge when Discord autocompletes. One code, one server, single use. ${expiresLabel(f.data?.expires_in)} The bot only answers when @mentioned or replied to.`}
          </Note>
          <Check
            n={3}
            title="Come back here once Discord says “Connected”"
            checkLabel="I've posted it"
            checking={f.step === "checking"}
            onCheck={() => void f.checkConnected()}
            onRemint={() => void f.startLink(true)}
            notYet={f.notYet}
            notYetText="Not connected yet. Post the command in your server first, then try again. If the bot said the code expired, get a new one."
          />
        </>
      )}
    </Card>
  );
}

const WHATSAPP_ERRORS: Record<string, string> = {
  bad_code: "That code doesn't match. Check the message WhatsApp sent you.",
  no_pending: "No pending connection. Send the WhatsApp message first.",
  expired: "That code expired. Start again to get a new one.",
  too_many_attempts: "Too many attempts. Start again to get a new code.",
  whatsapp_disabled: "WhatsApp isn't configured on this workspace yet.",
  whatsapp_number_missing: "WhatsApp isn't fully configured on this workspace yet.",
  not_admin: "Only an owner or admin can connect WhatsApp.",
};

function formatBindCode(value: string): string {
  const raw = value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  return raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}

export function WhatsAppConnect({ onConnected, autoStart = true }: { onConnected: () => void; autoStart?: boolean }) {
  const styles = useStyles(makeStyles);
  const [step, setStep] = useState<"linking" | "idle" | "await_code" | "confirming" | "done">(
    autoStart ? "linking" : "idle",
  );
  const [waUrl, setWaUrl] = useState("");
  const [prefill, setPrefill] = useState("");
  const [businessNumber, setBusinessNumber] = useState("");
  const [expiresIn, setExpiresIn] = useState<number | undefined>(undefined);
  const [code, setCode] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const [copiedManual, setCopiedManual] = useState<"message" | "with" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const startLink = useCallback(async (fresh: boolean) => {
    setError(null);
    if (fresh) setCode("");
    setStep("linking");
    try {
      const json = await apiJson<{
        wa_url?: string;
        prefill?: string;
        business_number?: string;
        expires_in?: number;
      }>("/api/connectors/whatsapp/link", { method: "POST", body: JSON.stringify(fresh ? { fresh: true } : {}) });
      if (!json?.wa_url) throw new Error("Couldn't create a connect link.");
      setWaUrl(json.wa_url);
      setPrefill(json.prefill ?? "");
      setBusinessNumber(json.business_number ?? "");
      setExpiresIn(json.expires_in);
      setStep("await_code");
    } catch (e) {
      setError(errorFrom(e, WHATSAPP_ERRORS, "Couldn't create a connect link."));
      setStep("idle");
    }
  }, []);

  const autoStarted = useRef(false);
  useEffect(() => {
    if (!autoStart || autoStarted.current) return;
    autoStarted.current = true;
    void startLink(false);
  }, [autoStart, startLink]);

  async function confirm() {
    const trimmed = code.trim();
    if (trimmed.length !== 9) return;
    setError(null);
    setStep("confirming");
    try {
      const json = await apiJson<{ ok?: boolean }>("/api/connectors/whatsapp/confirm", {
        method: "POST",
        body: JSON.stringify({ code: trimmed }),
      });
      if (!json?.ok) throw new Error("Couldn't confirm that code.");
      setStep("done");
      onConnected();
    } catch (e) {
      setError(errorFrom(e, WHATSAPP_ERRORS, serverMessageFrom(e) ?? "Couldn't confirm that code."));
      setStep("await_code");
    }
  }

  return (
    <Card title="Connect WhatsApp" blurb="Send one message, then type the code WhatsApp replies with." error={error}>
      {step === "linking" || step === "idle" ? (
        <Mint
          busy={step === "linking"}
          label={autoStart ? "Try again" : "Connect"}
          busyLabel="Creating link…"
          onPress={() => void startLink(true)}
        />
      ) : step === "done" ? (
        <Text style={styles.done}>Connected. You can message your agents from WhatsApp now.</Text>
      ) : (
        <>
          <StepTitle>1. Send the pre-filled WhatsApp message</StepTitle>
          <View style={styles.buttons}>
            <Primary
              label="Open WhatsApp"
              onPress={() => void Linking.openURL(waUrl)}
              style={[styles.rowButton, styles.whatsAppPrimary]}
              textStyle={styles.whatsAppPrimaryText}
            />
            <Secondary
              label="Get a new link"
              onPress={() => void startLink(true)}
              disabled={step === "confirming"}
              style={styles.rowButton}
            />
          </View>
          <Note>Don&apos;t edit the message. The code in it is what links your workspace.</Note>
          {businessNumber && prefill ? (
            <View style={styles.manual}>
              <Pressable
                style={styles.manualToggleHit}
                onPress={() => setManualOpen((open) => !open)}
                accessibilityRole="button"
                accessibilityState={{ expanded: manualOpen }}
              >
                <UnderlinedText style={styles.manualToggle}>Can&apos;t scan? Send it by hand</UnderlinedText>
              </Pressable>
              {manualOpen ? (
                <View style={styles.manualFields}>
                  <CopyField
                    label="Message"
                    value={`+${businessNumber}`}
                    copied={copiedManual === "message"}
                    onCopy={() => {
                      Clipboard.setString(`+${businessNumber}`);
                      setCopiedManual("message");
                      setTimeout(() => setCopiedManual(null), 1500);
                    }}
                  />
                  <CopyField
                    label="with"
                    value={prefill}
                    copied={copiedManual === "with"}
                    onCopy={() => {
                      Clipboard.setString(prefill);
                      setCopiedManual("with");
                      setTimeout(() => setCopiedManual(null), 1500);
                    }}
                  />
                </View>
              ) : null}
            </View>
          ) : null}
          <StepTitle>2. Enter the code WhatsApp replies with</StepTitle>
          <View style={styles.codeRow}>
            <ZaviTextField
              inSheet
              containerStyle={styles.codeField}
              style={styles.codeInput}
              multiline={false}
              value={code}
              onChangeText={(v) => setCode(formatBindCode(v))}
              onSubmitEditing={() => void confirm()}
              maxLength={9}
              placeholder="K7Q2-9F3M"
              autoCapitalize="characters"
              autoCorrect={false}
              autoComplete="off"
              accessibilityLabel="WhatsApp code"
            />
            <Primary
              label={step === "confirming" ? "Checking…" : "Confirm"}
              onPress={() => void confirm()}
              disabled={step === "confirming" || code.length !== 9}
            />
          </View>
          <Note>{expiresLabel(expiresIn)}</Note>
        </>
      )}
    </Card>
  );
}

const REMOVE_ERRORS: Record<string, string> = {
  not_admin: "Only an owner or admin can remove a number.",
  thread_not_found: "That number is no longer connected.",
};

export function WhatsAppNumbers({
  handsets,
  canManage,
  onChanged,
}: {
  handsets: WhatsAppHandset[];
  canManage: boolean;
  onChanged: () => void;
}) {
  const styles = useStyles(makeStyles);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<WhatsAppHandset | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove(h: WhatsAppHandset) {
    setConfirming(null);
    setError(null);
    setBusyId(h.id);
    try {
      const res = await apiFetch("/api/connectors/whatsapp/disconnect", {
        method: "POST",
        body: JSON.stringify({ thread_id: h.id }),
      });
      const json = (await res.json().catch(() => null)) as
        | { ok?: boolean; connected?: boolean; error?: { code?: string; message?: string } }
        | null;
      if (!res.ok || !json?.ok) {
        const code = String(json?.error?.code);
        setError(
          REMOVE_ERRORS[code] ??
            json?.error?.message ??
            `Couldn't remove that number (HTTP ${res.status}).`,
        );
        if (code === "thread_not_found") onChanged();
        return;
      }
      onChanged();
    } catch (e) {
      const code = e instanceof ApiFetchError ? e.code : "";
      setError(REMOVE_ERRORS[code] ?? serverMessageFrom(e) ?? "Couldn't remove that number.");
      if (code === "thread_not_found") onChanged();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <View style={styles.numbers}>
      <Text style={styles.cardTitle}>WhatsApp numbers</Text>
      <Note>
        Everyone who can message Zavi from WhatsApp in this workspace. Names come from each phone&apos;s WhatsApp
        profile at the time it was connected.
      </Note>
      {handsets.length === 0 ? <Note>No numbers are connected.</Note> : null}
      {handsets.map((h) => (
        <View key={h.id} style={styles.number}>
          <View style={styles.numberText}>
            <Text style={styles.numberName} numberOfLines={1}>
              {h.name ?? h.number}
            </Text>
            {h.name ? <Text style={styles.numberSub}>{h.number}</Text> : null}
          </View>
          {canManage ? (
            <Secondary
              label={busyId === h.id ? "Removing…" : "Remove"}
              onPress={() => setConfirming(h)}
              disabled={busyId !== null}
              textStyle={styles.removeText}
            />
          ) : null}
        </View>
      ))}
      <ErrorLine message={error} />
      {canManage ? (
        adding ? (
          <WhatsAppConnect
            onConnected={() => {
              setAdding(false);
              onChanged();
            }}
          />
        ) : (
          <Primary label="Add another number" onPress={() => setAdding(true)} />
        )
      ) : null}
      <ConfirmDialog
        visible={confirming !== null}
        icon="close"
        title="Remove this number?"
        message={
          confirming
            ? `Remove ${confirming.name ? `${confirming.name} (${confirming.number})` : confirming.number} from WhatsApp? Zavi will stop answering that phone. It can be connected again anytime with the two-step link.`
            : ""
        }
        cancelLabel="Keep it"
        confirmLabel="Remove"
        destructive
        onCancel={() => setConfirming(null)}
        onConfirm={() => confirming && void remove(confirming)}
      />
    </View>
  );
}

export function TeamsConnect({ onConnected }: { onConnected: () => void }) {
  const styles = useStyles(makeStyles);
  const { colors, textSelectionColor, keyboardAppearance } = useTheme();
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    apiJson<{ configured?: boolean }>("/api/connectors/teams/status")
      .then((s) => {
        if (alive) setConfigured(!!s?.configured);
      })
      .catch(() => {
        if (alive) setConfigured(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  async function connect() {
    const bindCode = code.trim();
    if (!bindCode) {
      setError(teamsBindError("missing_bind_code"));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await apiJson("/api/connectors/teams/bind", { method: "POST", body: JSON.stringify({ bind_code: bindCode }) });
      onConnected();
    } catch (e) {
      setError(teamsBindError(e instanceof ApiFetchError ? e.code : undefined));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card
      title="Connect Microsoft Teams"
      blurb="Add the Zavi app in Teams, then enter the one-time code it sends you. Nothing connects until you enter it."
      error={error}
    >
      {configured === null ? (
        <View style={styles.minting}>
          <ActivityIndicator size="small" color={colors.wire.ink} />
        </View>
      ) : !configured ? (
        <Note>Microsoft Teams support is coming soon. It isn’t enabled on your workspace yet.</Note>
      ) : (
        <>
          <StepTitle>1. Add the Zavi app to Teams</StepTitle>
          <Note>In Teams, go to Apps → Manage your apps → Upload an app and pick the downloaded package.</Note>
          <Note>Do this step on a computer: download the app package from Messaging on zaviagent.com.</Note>
          <StepTitle>2. Enter the code Zavi sends you</StepTitle>
          <Note>Right after the app is added, Zavi DMs you a one-time code in Teams.</Note>
          <View style={styles.codeRow}>
            <FocusRing radius={10} style={styles.codeField}>
              {(focus) => (
                <BottomSheetTextInput
                  keyboardAppearance={keyboardAppearance}
                  style={styles.input}
                  value={code}
                  onChangeText={(v) => setCode(v.toUpperCase())}
                  onSubmitEditing={() => void connect()}
                  placeholder="ABCD-EFGH"
                  placeholderTextColor={colors.muted}
                  selectionColor={textSelectionColor}
                  cursorColor={colors.ink}
                  selectionHandleColor={colors.ink}
                  editable={!submitting}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  autoComplete="off"
                  onFocus={focus.onFocus}
                  onBlur={focus.onBlur}
                  accessibilityLabel="Microsoft Teams connection code"
                />
              )}
            </FocusRing>
            <Primary
              label={submitting ? "Connecting…" : "Connect"}
              onPress={() => void connect()}
              disabled={submitting || !code.trim()}
            />
          </View>
        </>
      )}
    </Card>
  );
}

function Card({
  title,
  blurb,
  error,
  children,
}: {
  title: string;
  blurb: string;
  error: string | null;
  children: React.ReactNode;
}) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{title}</Text>
      <Text style={styles.blurb}>{blurb}</Text>
      {children}
      <ErrorLine message={error} />
    </View>
  );
}

function Check(props: {
  n: number;
  title: string;
  checkLabel: string;
  checking: boolean;
  onCheck: () => void;
  onRemint: () => void;
  notYet: boolean;
  notYetText: string;
}) {
  const styles = useStyles(makeStyles);
  return (
    <>
      <StepTitle>{`${props.n}. ${props.title}`}</StepTitle>
      <View style={styles.buttons}>
        <Primary
          label={props.checking ? "Checking…" : props.checkLabel}
          onPress={props.onCheck}
          disabled={props.checking}
          style={styles.rowButton}
        />
        <Secondary
          label="Get a new one"
          onPress={props.onRemint}
          disabled={props.checking}
          style={styles.rowButton}
        />
      </View>
      {props.notYet ? <Note>{props.notYetText}</Note> : null}
    </>
  );
}

function Mint({
  busy,
  label,
  busyLabel,
  onPress,
}: {
  busy: boolean;
  label: string;
  busyLabel: string;
  onPress: () => void;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return busy ? (
    <View style={styles.minting}>
      <ActivityIndicator size="small" color={colors.wire.ink} />
      <Text style={styles.note}>{busyLabel}</Text>
    </View>
  ) : (
    <Primary label={label} onPress={onPress} />
  );
}

const StepTitle = ({ children }: { children: string }) => {
  const styles = useStyles(makeStyles);
  return <Text style={styles.step}>{children}</Text>;
};
const Note = ({ children }: { children: React.ReactNode }) => {
  const styles = useStyles(makeStyles);
  return <Text style={styles.note}>{children}</Text>;
};

function Primary({
  label,
  onPress,
  disabled,
  style,
  textStyle,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
}) {
  const styles = useStyles(makeStyles);
  return (
    <Pressable
      style={({ pressed }) => [styles.primary, style, (pressed || disabled) && styles.dim]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
    >
      <Text style={[styles.primaryText, textStyle]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

function Secondary({
  label,
  onPress,
  disabled,
  style,
  textStyle,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
}) {
  const styles = useStyles(makeStyles);
  return (
    <Pressable
      style={({ pressed }) => [styles.secondary, style, (pressed || disabled) && styles.dim]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
    >
      <Text style={[styles.secondaryText, textStyle]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

function CopyField({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <View style={styles.copyField}>
      <Text style={styles.copyLabel}>{label}</Text>
      <View style={styles.codeRow}>
        <Text style={styles.code} selectable>
          {value}
        </Text>
        <Pressable
          style={({ pressed }) => [styles.copyIcon, pressed && styles.dim]}
          onPress={onCopy}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={copied ? "Copied" : `Copy ${label.toLowerCase()}`}
        >
          <Icon
            name={copied ? "check" : "copy"}
            size={18}
            color={copied ? colors.status.greenStrong : colors.wire.strong}
          />
        </Pressable>
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  card: { marginTop: space.md, borderWidth: 1, borderColor: colors.wire.line, borderRadius: 16, padding: 16, gap: 12 },
  cardTitle: { fontFamily: font.family.semi, fontSize: 15, color: colors.wire.strong },
  blurb: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 19, color: colors.textSecondary },
  step: { marginTop: 8, fontFamily: font.family.semi, fontSize: 13.5, color: colors.wire.strong },
  note: { fontFamily: font.family.regular, fontSize: 12.5, lineHeight: 18, color: colors.textSecondary },
  manual: { gap: 8 },
  manualToggleHit: { alignSelf: "flex-start" },
  manualToggle: { fontFamily: font.family.medium, fontSize: 12.5, color: colors.wire.strong },
  manualFields: { gap: 12, padding: 12, borderRadius: 12, backgroundColor: colors.wire.tint },
  copyField: { gap: 6 },
  copyLabel: { fontFamily: font.family.medium, fontSize: 12.5, color: colors.textSecondary },
  buttons: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10 },
  rowButton: { flex: 1, minWidth: 0 },
  minting: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 40 },
  codeRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  codeField: { flex: 1 },
  codeInput: { minHeight: 46 },
  code: {
    flex: 1,
    minHeight: 48,
    fontFamily: Platform.OS === "android" ? "monospace" : "Courier",
    fontSize: 14,
    lineHeight: 20,
    color: colors.wire.ink,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.wire.line,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    overflow: "hidden",
  },
  copyIcon: {
    width: 48,
    height: 48,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.wire.line,
    backgroundColor: colors.panel,
    alignItems: "center",
    justifyContent: "center",
  },
  input: {
    minHeight: 42,
    paddingHorizontal: 12,
    fontFamily: font.family.medium,
    fontSize: 15,
    color: colors.wire.strong,
    letterSpacing: 1,
  },
  primary: {
    height: 48,
    paddingHorizontal: 16,
    borderRadius: 999,
    backgroundColor: colors.wire.ink,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryText: { includeFontPadding: false, fontFamily: font.family.semi, fontSize: 14, color: colors.onInk },
  telegramPrimary: {
    backgroundColor: "#26A5E4",
  },
  telegramPrimaryText: { color: colors.onAccent },
  telegramSecondary: {
    borderColor: "#26A5E4",
    backgroundColor: colors.panel,
  },
  telegramSecondaryText: { color: "#26A5E4" },
  whatsAppPrimary: {
    backgroundColor: "#25D366",
  },
  whatsAppPrimaryText: { color: colors.onAccent },
  discordButton: {
    alignSelf: "flex-start",
    height: 48,
    paddingHorizontal: 16,
    borderRadius: 999,
    backgroundColor: "#5865F2",
    alignItems: "center",
    justifyContent: "center",
  },
  discordButtonText: { includeFontPadding: false, fontFamily: font.family.semi, fontSize: 14, color: colors.onAccent },
  secondary: {
    height: 48,
    paddingHorizontal: 16,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.wire.line,
    backgroundColor: colors.panel,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryText: { includeFontPadding: false, fontFamily: font.family.semi, fontSize: 14, color: colors.wire.strong },
  removeText: { color: colors.status.redVivid },
  done: { fontFamily: font.family.medium, fontSize: 14, color: colors.status.greenStrong },
  numbers: { marginTop: space.md, gap: 8 },
  number: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
    borderColor: colors.wire.line,
    borderRadius: 12,
    padding: 12,
  },
  numberText: { flex: 1, minWidth: 0 },
  numberName: { fontFamily: font.family.semi, fontSize: 14, color: colors.wire.strong },
  numberSub: { marginTop: 2, fontFamily: font.family.regular, fontSize: 12.5, color: colors.textSecondary },
  dim: { opacity: 0.55 },
});
