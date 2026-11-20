import { useEffect, useRef, useState } from "react";
import { FlatList, Keyboard, Pressable, StyleSheet, Text, View } from "react-native";
import { Redirect, useLocalSearchParams } from "expo-router";
import { Icon } from "../../../../components/Icon";
import { KeyboardAvoider } from "../../../../components/KeyboardAvoider";
import { ZaviTextField } from "../../../../components/ZaviTextField";
import { ReadOnlyNote, StateLine, UgcScreen } from "../../../../components/channels/UgcParts";
import { OfferCard, SendOfferSheet } from "../../../../components/channels/UgcOffers";
import { relativeTime } from "../../../../features/channels/channelPage";
import { type ThreadMessage } from "../../../../features/channels/ugc";
import { inviteOffersNote, threadEmptyLine, threadFirst, threadInfoLine } from "../../../../features/channels/ugcInbox";
import { useInviteMessages, useSendInviteMessage } from "../../../../features/channels/ugcInboxHooks";
import {
  useCanWrite,
  isInviteId,
  useCreatorCard,
  useSendMessage,
  useThreadMessages,
  useThreadOffers,
  useThreads,
} from "../../../../features/channels/ugcHooks";
import { CHANNELS_ENABLED } from "../../../../lib/flags";
import { font, radius, space, type Colors } from "../../../../theme/tokens";
import { useStyles, useTheme } from "../../../../theme/theme";

const MAX_LEN = 4000;

export default function ThreadRoute() {
  if (!CHANNELS_ENABLED) return <Redirect href="/chat" />;
  return <Thread />;
}

function Thread() {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const { id: memberId = "" } = useLocalSearchParams<{ id?: string }>();
  const invite = isInviteId(memberId);
  const card = useCreatorCard(memberId);
  const threads = useThreads();
  const summary = invite ? undefined : threads.data?.find((t) => t.human_member_id === memberId);
  const threadId = summary?.thread_id ?? null;
  const memberMessages = useThreadMessages(threadId);
  const inviteMessages = useInviteMessages(memberId);
  const messages = invite ? inviteMessages : memberMessages;
  const offers = useThreadOffers(threadId);
  const send = useSendMessage();
  const canWrite = useCanWrite();
  const sendInvite = useSendInviteMessage();
  const sending = send.isPending || sendInvite.isPending;
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [emailNote, setEmailNote] = useState<{ memberId: string; note: string } | null>(null);
  const [offering, setOffering] = useState(false);
  const list = useRef<FlatList<ThreadMessage>>(null);
  const inFlight = useRef(false);

  const knownName = card.data?.display_name || summary?.display_name || null;
  const name = knownName ?? "the creator";
  const first = threadFirst(knownName);
  const rows = [...(messages.data ?? [])].reverse();
  const allOffers = [...(offers.data ?? [])];

  useEffect(() => {
    if (rows.length) list.current?.scrollToOffset({ offset: 0, animated: false });
  }, [rows.length]);

  function submit() {
    const body = text.trim();
    if (!body || sending || inFlight.current) return;
    inFlight.current = true;
    const settled = () => {
      inFlight.current = false;
    };
    setError(null);
    if (invite) {
      sendInvite.mutate(
        { memberId, body },
        {
          onSuccess: (r) => {
            setText("");
            if (r?.email_note) setEmailNote({ memberId, note: r.email_note });
          },
          onError: (e) => setError(e instanceof Error && e.message ? e.message : "Couldn't send. Try again."),
          onSettled: settled,
        },
      );
      return;
    }
    send.mutate(
      { memberId, threadId, body },
      {
        onSuccess: () => setText(""),
        onError: (e) => setError(e instanceof Error && e.message ? e.message : "Couldn't send. Try again."),
        onSettled: settled,
      },
    );
  }

  return (
    <UgcScreen title={knownName ?? "Messages"}>
      <KeyboardAvoider style={styles.body}>
        <FlatList
          ref={list}
          inverted
          data={rows}
          keyExtractor={(m) => m.id}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            <View>
              <StateLine
                loading={(invite || !!threadId) && messages.isLoading}
                error={messages.isError}
                onRetry={() => void messages.refetch()}
                empty={threadEmptyLine(invite, first)}
              />
            </View>
          }
          ListFooterComponent={
            <View style={styles.info}>
              <Icon name="mail" size={14} color={colors.muted} />
              <Text style={styles.infoText}>{threadInfoLine(invite, first)}</Text>
            </View>
          }
          ListHeaderComponent={
            allOffers.length ? (
              <View style={styles.offers}>
                {allOffers.map((o) => (
                  <OfferCard key={o.id} offer={o} name={name} first={first} />
                ))}
              </View>
            ) : null
          }
          renderItem={({ item: m }) => {
            const mine = m.sender_kind === "tenant";
            const system = m.sender_kind === "system";
            return (
              <View style={[styles.msgWrap, mine && styles.mineWrap]}>
                <View style={[styles.bubble, mine ? styles.mine : styles.theirs, system && styles.system]}>
                  <Text style={[styles.msg, mine && styles.mineText]} selectable>
                    {m.body}
                  </Text>
                </View>
                <Text style={styles.at}>{relativeTime(m.created_at)}</Text>
              </View>
            );
          }}
        />
        {error ? (
          <Text style={styles.error} accessibilityRole="alert">
            {error}
          </Text>
        ) : null}
        {!canWrite ? (
          <View style={styles.readOnly}>
            <ReadOnlyNote />
          </View>
        ) : null}
        {!invite && canWrite ? (
          <Pressable
            style={styles.offerBar}
            onPress={() => {
              Keyboard.dismiss();
              setOffering(true);
            }}
            accessibilityRole="button"
            accessibilityLabel="Send a custom offer"
          >
            <Icon name="file" size={15} color={colors.ink} />
            <Text style={styles.offerBarText}>Send a custom offer</Text>
          </Pressable>
        ) : null}
        {canWrite ? <View style={styles.composer}>
          <ZaviTextField
            containerStyle={styles.composerField}
            value={text}
            onChangeText={setText}
            placeholder={`Message ${first}`}
            maxLength={MAX_LEN}
            accessibilityLabel="Message"
          />
          <Pressable
            style={[styles.send, (!text.trim() || sending) && styles.disabled]}
            onPress={submit}
            disabled={!text.trim() || sending}
            accessibilityRole="button"
            accessibilityLabel="Send message"
          >
            <Icon name="send" size={18} color={colors.onInk} />
          </Pressable>
        </View> : null}
        {invite && canWrite ? (
          <View style={styles.inviteNotes}>
            {emailNote && emailNote.memberId === memberId ? <Text style={styles.emailNote}>{emailNote.note}</Text> : null}
            <View style={styles.dashed}>
              <Text style={styles.dashedText}>{inviteOffersNote(first)}</Text>
            </View>
          </View>
        ) : null}
      </KeyboardAvoider>
      <SendOfferSheet open={offering} onClose={() => setOffering(false)} to={first} memberId={memberId} threadId={threadId} />
    </UgcScreen>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    body: { flex: 1 },
    list: { paddingHorizontal: space.lg, paddingTop: 20, paddingBottom: 20, gap: space.sm },
    msgWrap: { alignItems: "flex-start", gap: 2 },
    mineWrap: { alignItems: "flex-end" },
    bubble: { maxWidth: "82%", paddingHorizontal: 12, paddingVertical: 8, borderRadius: radius.lg },
    mine: { backgroundColor: colors.ink },
    theirs: { backgroundColor: colors.soft },
    system: { backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.line },
    msg: { fontFamily: font.family.regular, fontSize: 14, lineHeight: 20, color: colors.ink },
    mineText: { color: colors.onInk },
    at: { fontFamily: font.family.regular, fontSize: 10, color: colors.muted },
    offers: { gap: space.sm, marginBottom: space.sm },
    offerBar: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", marginHorizontal: space.lg, marginBottom: 6, minHeight: 34, paddingHorizontal: 12, borderWidth: 1, borderColor: colors.line, borderRadius: radius.pill },
    offerBarText: { fontFamily: font.family.semi, fontSize: 13, color: colors.ink },
    info: { flexDirection: "row", alignItems: "flex-start", gap: 6, paddingBottom: space.sm },
    infoText: { flex: 1, fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.muted },
    emailNote: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.muted },
    inviteNotes: { gap: 6, paddingHorizontal: space.lg, paddingBottom: space.sm },
    dashed: { paddingHorizontal: space.md, paddingVertical: 10, borderWidth: 1, borderStyle: "dashed", borderColor: colors.line, borderRadius: radius.md, backgroundColor: colors.soft },
    dashedText: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.textSecondary },
    error: { paddingHorizontal: space.lg, paddingBottom: 4, fontFamily: font.family.regular, fontSize: 12, color: colors.status.redDot },
    readOnly: { paddingHorizontal: space.lg, paddingVertical: space.sm },
    composer: {
      flexDirection: "row",
      alignItems: "flex-end",
      gap: space.sm,
      paddingHorizontal: space.lg,
      paddingVertical: space.sm,
      borderTopWidth: 1,
      borderTopColor: colors.line,
    },
    composerField: { flex: 1 },
    send: { width: 46, height: 46, alignItems: "center", justifyContent: "center", borderRadius: 23, backgroundColor: colors.ink },
    disabled: { opacity: 0.4 },
  });
