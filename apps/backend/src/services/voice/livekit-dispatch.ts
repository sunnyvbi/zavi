
import {
  AccessToken,
  AgentDispatchClient,
  type VideoGrant,
} from "livekit-server-sdk";

export const VOICE_AGENT_NAME = "praxis-voice";
export const VOICE_JWT_TTL_SECONDS = 3600;
export const VOICE_ROOM_PREFIX = "voice:";

export interface VoiceSessionMintInput {
  sessionId: string;
  userId: string;
  participantName?: string;
  agentSlug: string;
  threadId: string;
  tenantId: string;
}

export interface VoiceSessionMintResult {
  room: string;
  token: string;
  ttlSeconds: number;
}

function getEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(`${name} not configured`);
  }
  return v;
}

export function buildVoiceRoomName(sessionId: string): string {
  return `${VOICE_ROOM_PREFIX}${sessionId}`;
}

export async function mintVoiceSessionToken(
  input: VoiceSessionMintInput,
): Promise<VoiceSessionMintResult> {
  const apiKey = getEnv("LIVEKIT_API_KEY");
  const apiSecret = getEnv("LIVEKIT_API_SECRET");

  const room = buildVoiceRoomName(input.sessionId);

  const at = new AccessToken(apiKey, apiSecret, {
    identity: input.userId,
    name: input.participantName ?? `user-${input.userId.slice(0, 8)}`,
    ttl: VOICE_JWT_TTL_SECONDS,
  });

  const grant: VideoGrant = {
    room,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  };
  at.addGrant(grant);

  const token = await at.toJwt();
  return { room, token, ttlSeconds: VOICE_JWT_TTL_SECONDS };
}

export async function createVoiceAgentDispatch(
  input: VoiceSessionMintInput,
): Promise<void> {
  const apiKey = getEnv("LIVEKIT_API_KEY");
  const apiSecret = getEnv("LIVEKIT_API_SECRET");
  const livekitUrl = getEnv("LIVEKIT_URL");

  const room = buildVoiceRoomName(input.sessionId);
  const client = new AgentDispatchClient(livekitUrl, apiKey, apiSecret);

  await client.createDispatch(room, VOICE_AGENT_NAME, {
    metadata: JSON.stringify({
      session_id: input.sessionId,
      agent_slug: input.agentSlug,
      thread_id: input.threadId,
      tenant_id_trace_only: input.tenantId,
    }),
  });
}
