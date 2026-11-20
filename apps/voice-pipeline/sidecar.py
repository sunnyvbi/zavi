"""
Praxis voice sidecar — LiveKit Worker + STT/TTS/LLM pipeline.

Per plan §"P0 — Architecture: LiveKit Cloud + Python sidecar (IO-only)":

    Architecture:
      [Web mic] -WebRTC-> [LiveKit Cloud] <--WebRTC-- [this process]
                                                          |
                                          STT (Deepgram Nova-3)
                                                          |
                              POST /internal/voice/agent-turn (HMAC-signed)
                                                          v
                                  [Node praxis-backend / runner.ts]
                                  - existing chat-dispatcher path
                                  - existing tool registry (50+ tools)
                                  - existing approval gates
                                  - streams text response back
                                                          |
                              TTS (Cartesia Sonic-3.5 voice=Katie)
                                                          v
      [Web speaker] <-WebRTC- [LiveKit Cloud] <--WebRTC--- ┘

The custom Praxis LLM adapter (`PraxisHttpLLM`) implements the
`livekit-agents` LLM interface but delegates each chat turn to the Node
backend via HTTP. This preserves Praxis's 50+ tools + approval gates +
"never push main" double-confirm rule — the sidecar is intentionally
dumb about agent behavior, only owning realtime IO + turn detection.

Boot order (matches plan §"Migration / deploy / flag flip sequencing"):
  1. scripts/load-secrets.py wrote /app/apps/voice-pipeline/.env
  2. We load that .env into os.environ
  3. We start a tiny health server on :8000 (/internal/health = 200 OK,
     /internal/voice/warmup = HMAC-checked 200 OK; both NON-billable)
  4. We register a LiveKit Worker with agent_name=praxis-voice
  5. LiveKit Cloud dispatches us into rooms minted by Slice 2's
     POST /api/voice/session/start. On dispatch, we read metadata,
     call /internal/voice/session/hydrate for agent context, and
     attach STT/LLM/TTS to the room.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import hmac
import json
import logging
import os
import threading
import time
import uuid
from typing import Any, AsyncIterator, Optional

import aiohttp
import httpx
import structlog
from aiohttp import web
from dotenv import load_dotenv

try:
    from livekit import agents as lk_agents
    from livekit.agents import JobContext, WorkerOptions, cli
    from livekit.plugins import deepgram as lk_deepgram
    from livekit.plugins import cartesia as lk_cartesia

    _LIVEKIT_AVAILABLE = True
except ImportError:  # pragma: no cover — only on initial bootstrap
    lk_agents = None  # type: ignore[assignment]
    JobContext = Any  # type: ignore[assignment,misc]
    WorkerOptions = Any  # type: ignore[assignment,misc]
    cli = None  # type: ignore[assignment]
    lk_deepgram = None  # type: ignore[assignment]
    lk_cartesia = None  # type: ignore[assignment]
    _LIVEKIT_AVAILABLE = False

from redactor import redact_log_string, redact_voice_transcript_full  # noqa: E402

load_dotenv("/app/apps/voice-pipeline/.env")

def _redact_processor(_logger, _name, event_dict):
    """structlog processor that redacts every string field's value
    BEFORE emit. Belt-and-suspenders on top of the Node-side redactor."""
    for k, v in list(event_dict.items()):
        event_dict[k] = redact_log_string(v)
    return event_dict

def setup_logging() -> structlog.stdlib.BoundLogger:
    logging.basicConfig(
        level=os.environ.get("LIVEKIT_LOG_LEVEL", "INFO").upper(),
        format="%(message)s",
    )
    logging.getLogger("livekit").setLevel(
        os.environ.get("LIVEKIT_LOG_LEVEL", "INFO").upper()
    )
    logging.getLogger("deepgram").setLevel("WARNING")
    logging.getLogger("cartesia").setLevel("WARNING")

    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.stdlib.add_log_level,
            _redact_processor,  # redact before serialization
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )
    return structlog.get_logger()

log = setup_logging()

NODE_INTERNAL_BASE = os.environ.get(
    "PRAXIS_NODE_INTERNAL_BASE", "http://127.0.0.1:4000"
)
HMAC_SECRET = os.environ.get("PRAXIS_VOICE_SIDECAR_HMAC", "")
HMAC_IAT_WINDOW_MS = 60_000

def _sign(body: bytes) -> str:
    return (
        hmac.new(HMAC_SECRET.encode("utf-8"), body, hashlib.sha256)
        .digest()
        .hex()  # base64url would match Node side; using hex is bug — fix below
    )

def _sign_base64url(body: bytes) -> str:
    import base64

    sig = hmac.new(HMAC_SECRET.encode("utf-8"), body, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(sig).rstrip(b"=").decode("ascii")

async def post_internal(path: str, body: dict) -> dict | None:
    """Sign + POST to /internal/voice/<path> on Node. Returns parsed JSON
    on 2xx, None on 4xx/5xx. Caller decides whether to retry."""
    if not HMAC_SECRET:
        log.warn("post_internal: PRAXIS_VOICE_SIDECAR_HMAC not set", path=path)
        return None

    raw = json.dumps(body, separators=(",", ":")).encode("utf-8")
    sig = _sign_base64url(raw)
    headers = {
        "Content-Type": "application/json",
        "X-Praxis-Sidecar-Sig": sig,
        "X-Praxis-Event-Id": str(uuid.uuid4()),
        "X-Praxis-Iat": str(int(time.time() * 1000)),
    }
    url = f"{NODE_INTERNAL_BASE}/internal/voice/{path}"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.post(url, content=raw, headers=headers)
            if r.status_code >= 400:
                log.warn(
                    "post_internal non-ok",
                    path=path,
                    status=r.status_code,
                    body=r.text[:200],
                )
                return None
            return r.json()
    except (httpx.HTTPError, httpx.RequestError) as e:
        log.warn("post_internal exception", path=path, error=str(e))
        return None

async def handle_health(_req: web.Request) -> web.Response:
    return web.json_response(
        {"ok": True, "service": "praxis-voice-sidecar", "uptime_s": time.monotonic()}
    )

async def start_health_server() -> web.AppRunner:
    app = web.Application()
    app.router.add_get("/internal/health", handle_health)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", 8000)
    await site.start()
    log.info("health server listening on :8000")
    return runner

if _LIVEKIT_AVAILABLE:
    from livekit.agents import llm as lk_llm

    class PraxisHttpLLM(lk_llm.LLM):
        """LiveKit LLM adapter that round-trips through Node runner.ts.

        Per plan §"P0 Architecture" line 56: this is the SEAM that
        preserves Praxis's 50+ tools + approval gates + double-confirm
        rule. livekit-plugins-anthropic would bypass them entirely.

        The Node side runs the agent through chat-dispatcher and streams
        text back. For Slice 3 we keep the interface tight: take the
        latest user transcript + thread context, call /internal/voice/
        agent-turn, return the streamed text.

        TODO (Slice 3b): once Node /internal/voice/agent-turn returns
        a proper SSE / chunked stream, switch this to a true streaming
        generator. Right now it accumulates server response + yields
        as a single chunk (sub-second turn latency is acceptable on
        first cut; barge-in still works because TTS is the bottleneck).
        """

        def __init__(self, session_id: str, thread_id: str, agent_slug: str) -> None:
            super().__init__()
            self._session_id = session_id
            self._thread_id = thread_id
            self._agent_slug = agent_slug

        def chat(
            self,
            *,
            chat_ctx: lk_llm.ChatContext,
            **_kwargs: Any,
        ) -> lk_llm.LLMStream:
            return _PraxisLLMStream(
                session_id=self._session_id,
                thread_id=self._thread_id,
                agent_slug=self._agent_slug,
                chat_ctx=chat_ctx,
            )

    class _PraxisLLMStream(lk_llm.LLMStream):
        def __init__(
            self,
            *,
            session_id: str,
            thread_id: str,
            agent_slug: str,
            chat_ctx: lk_llm.ChatContext,
        ) -> None:
            super().__init__(chat_ctx=chat_ctx, fnc_ctx=None)
            self._session_id = session_id
            self._thread_id = thread_id
            self._agent_slug = agent_slug

        async def _main_task(self) -> None:
            text = ""
            for m in reversed(self._chat_ctx.messages):
                if m.role == "user":
                    text = m.content if isinstance(m.content, str) else ""
                    break
            text_redacted = redact_voice_transcript_full(text)

            resp = await post_internal(
                "agent-turn",
                {
                    "session_id": self._session_id,
                    "agent_slug": self._agent_slug,
                    "thread_id": self._thread_id,
                    "user_text": text_redacted,
                },
            )
            content = ""
            if resp and isinstance(resp, dict):
                content = (
                    resp.get("text")
                    or resp.get("response")
                    or resp.get("placeholder", "")
                    or ""
                )
            if not content:
                content = "Sorry, I didn't catch that — try again or switch to text."

            self._event_ch.send_nowait(
                lk_llm.ChatChunk(
                    request_id=str(uuid.uuid4()),
                    choices=[
                        lk_llm.Choice(
                            delta=lk_llm.ChoiceDelta(content=content, role="assistant"),
                            index=0,
                        )
                    ],
                )
            )
            self._event_ch.close()

async def entrypoint(ctx: "JobContext") -> None:
    if not _LIVEKIT_AVAILABLE:
        log.error("entrypoint invoked but livekit-agents unavailable")
        return
    metadata_raw = ctx.job.metadata or "{}"
    try:
        meta = json.loads(metadata_raw)
    except json.JSONDecodeError:
        log.error("invalid dispatch metadata", raw=metadata_raw[:120])
        return

    session_id = meta.get("session_id")
    agent_slug = meta.get("agent_slug")
    thread_id = meta.get("thread_id")
    if not session_id or not agent_slug or not thread_id:
        log.error(
            "missing required metadata", session_id=session_id, agent_slug=agent_slug
        )
        return

    log.info(
        "voice dispatch received",
        session_id=session_id,
        agent_slug=agent_slug,
        thread_id=thread_id,
    )

    await post_internal(
        "session/hydrate",
        {"session_id": session_id},
    )

    await ctx.connect()

    try:
        from livekit.agents import AgentSession, Agent
        from livekit.plugins import silero

        deepgram_stt = lk_deepgram.STT(
            model="nova-3",
            language="en",
            smart_format=True,
            interim_results=True,
        )
        cartesia_tts = lk_cartesia.TTS(
            model="sonic-3.5-2026-05-04",
            voice="Katie",
        )
        praxis_llm = PraxisHttpLLM(
            session_id=session_id, thread_id=thread_id, agent_slug=agent_slug
        )

        session = AgentSession(
            vad=silero.VAD.load(),
            stt=deepgram_stt,
            llm=praxis_llm,
            tts=cartesia_tts,
        )
        await session.start(
            agent=Agent(
                instructions="You are a Praxis voice agent. Keep replies short and spoken-natural."
            ),
            room=ctx.room,
        )
        log.info("voice pipeline started", session_id=session_id)

        disconnect_evt = asyncio.Event()

        @ctx.room.on("participant_disconnected")
        def _on_participant_left(_participant: Any) -> None:  # noqa: ANN401
            disconnect_evt.set()

        if len(ctx.room.remote_participants) == 0:
            log.info("no remote participants at start — ending", session_id=session_id)
        else:
            await disconnect_evt.wait()
        end_reason = "livekit_disconnect"
    except Exception as e:  # noqa: BLE001 — log loud, notify, keep worker alive
        log.error(
            "voice pipeline construction/runtime error",
            session_id=session_id,
            error=repr(e),
        )
        end_reason = "error"
    finally:
        await post_internal(
            "session/end",
            {"session_id": session_id, "end_reason": end_reason},
        )
        log.info("voice dispatch finished", session_id=session_id, end_reason=end_reason)

def _run_health_server_thread() -> None:
    """Run the :8000 health server in its own event loop on a daemon
    thread. cli.run_app() owns the main thread + its own loop, so the
    health server can't share it. Docker's HEALTHCHECK curls this."""
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    loop.run_until_complete(start_health_server())
    loop.run_forever()

def main() -> None:
    threading.Thread(target=_run_health_server_thread, daemon=True).start()

    if not _LIVEKIT_AVAILABLE:
        log.error("livekit-agents not installed — health-only mode")
        threading.Event().wait()  # block forever; keep container alive
        return

    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            agent_name="praxis-voice",
        )
    )

if __name__ == "__main__":
    main()
