
import PostalMime from "postal-mime";

const DEFAULT_AUTHSERV_ID = "mx.cloudflare.net";

export function extractTrustedAuthResults(parsedHeaders, trustedAuthservId) {
  const trusted = String(trustedAuthservId || DEFAULT_AUTHSERV_ID).trim().toLowerCase();
  for (const h of parsedHeaders ?? []) {
    if (String(h?.key ?? "").toLowerCase() !== "authentication-results") continue;
    const value = String(h?.value ?? "");
    const authservId = value.split(";")[0].trim().toLowerCase();
    if (authservId === trusted) return value;
  }
  return null;
}

async function hmacSign(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(buf) {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const ATT_ALLOW = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "text/csv": "csv",
  "text/plain": "txt",
};
const ATT_MAX_BYTES = 6 * 1024 * 1024;
const ATT_MAX_COUNT = 5;
const ATT_TOTAL_BUDGET_BYTES = 7 * 1024 * 1024;

function u8ToBase64(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function safeFilename(name, ext) {
  const base = String(name ?? "")
    .replace(/[/\\\r\n\t\0]/g, "_")
    .replace(/[^\w.\- ]/g, "")
    .trim()
    .slice(0, 120);
  if (base) return base;
  return `attachment.${ext}`;
}

async function buildInlineAttachments(parsed) {
  const out = [];
  let skipped = 0;
  let totalBytes = 0;
  for (const a of parsed.attachments ?? []) {
    if (out.length >= ATT_MAX_COUNT) {
      skipped++;
      continue;
    }
    const mime = String(a?.mimeType ?? "").toLowerCase().split(";")[0].trim();
    const ext = ATT_ALLOW[mime];
    if (!ext) {
      skipped++;
      continue;
    }
    const bytes =
      a.content instanceof ArrayBuffer
        ? new Uint8Array(a.content)
        : typeof a.content === "string"
          ? new TextEncoder().encode(a.content)
          : a.content?.buffer
            ? new Uint8Array(a.content.buffer)
            : null;
    if (!bytes || bytes.length === 0) {
      skipped++;
      continue;
    }
    if (bytes.length > ATT_MAX_BYTES || totalBytes + bytes.length > ATT_TOTAL_BUDGET_BYTES) {
      skipped++;
      continue;
    }
    totalBytes += bytes.length;
    out.push({
      filename: safeFilename(a.filename, ext),
      mime_type: mime,
      ext,
      size_bytes: bytes.length,
      sha256: await sha256Hex(bytes),
      content_base64: u8ToBase64(bytes),
    });
  }
  return { attachments: out, skipped_attachments: skipped };
}

export default {
  async email(message, env, ctx) {
    const rawBuf = new Uint8Array(await new Response(message.raw).arrayBuffer());
    const bodyHash = await sha256Hex(rawBuf);

    const rawKey = `inbound/${crypto.randomUUID()}.eml`;
    await env.RAW_MIME.put(rawKey, rawBuf, {
      httpMetadata: { contentType: "message/rfc822" },
    });

    const parsed = await new PostalMime().parse(rawBuf);

    const headers = {};
    for (const h of parsed.headers ?? []) {
      const k = String(h?.key ?? "").toLowerCase();
      if (!k) continue;
      (headers[k] ??= []).push(String(h?.value ?? ""));
    }

    const authResults = extractTrustedAuthResults(
      parsed.headers,
      env.TRUSTED_AUTHSERV_ID ?? DEFAULT_AUTHSERV_ID,
    );

    const addrList = (field) =>
      (Array.isArray(field) ? field : field ? [field] : [])
        .map((a) => String(a?.address ?? "").trim().toLowerCase())
        .filter(Boolean);

    const { attachments, skipped_attachments } = await buildInlineAttachments(parsed);

    const envelope = {
      envelope_to: message.to,
      from: String(parsed.from?.address ?? "").trim().toLowerCase(),
      envelope_from: String(message.from ?? "").trim().toLowerCase(),
      auth_results: authResults,
      to: addrList(parsed.to),
      cc: addrList(parsed.cc),
      subject: parsed.subject ?? "",
      message_id: parsed.messageId ?? "",
      in_reply_to: parsed.inReplyTo ?? "",
      references: (parsed.references ?? "")
        .split(/\s+/)
        .filter(Boolean),
      text: parsed.text ?? "",
      html: parsed.html ?? "",
      headers,
      raw_mime_ref: rawKey,
      body_hash: bodyHash,
      spam_verdict: "unknown",
      attachments,
      skipped_attachments,
    };

    const ts = Math.floor(Date.now() / 1000).toString();
    const body = JSON.stringify(envelope);
    const sig = "v0=" + (await hmacSign(env.EMAIL_WEBHOOK_SECRET, `v0:${ts}:${body}`));

    const resp = await fetch(env.PRAXIS_EMAIL_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Praxis-Email-Timestamp": ts,
        "X-Praxis-Email-Signature": sig,
      },
      body,
    });

    if (!resp.ok) {
      message.setReject(`backend ingest failed: ${resp.status}`);
    }
  },
};
