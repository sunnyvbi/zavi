
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";

const SLUG_RE = /^[a-z][a-z0-9-]{0,39}$/;
const RESERVED_SLUGS = new Set([
  "feedback",
  "clear",
  "help",
  "run",
  "decision",
]);

const upsertBody = z.object({
  slug: z.string().regex(SLUG_RE),
  name: z.string().min(1).max(80),
  description: z.string().max(200).optional().default(""),
  instructions_md: z.string().max(8000).default(""),
});

type StableError = {
  status: number;
  body: { error: { code: string; message: string } };
};

function mapPostgresError(
  err: { code?: string; message?: string },
): StableError {
  const msg = err.message ?? "";
  if (err.code === "42501") {
    return {
      status: 403,
      body: {
        error: {
          code: "not_authorized",
          message: "Not a member of the active tenant.",
        },
      },
    };
  }
  if (msg.includes("tenant_commands_slug_not_reserved")) {
    return {
      status: 400,
      body: {
        error: {
          code: "reserved_slug",
          message:
            "That slug is reserved by a built-in command. Pick another.",
        },
      },
    };
  }
  if (msg.includes("tenant_commands_slug_check")) {
    return {
      status: 400,
      body: {
        error: {
          code: "invalid_slug",
          message:
            "Slug must be lowercase letters/digits/hyphens, start with a letter, 1–40 chars.",
        },
      },
    };
  }
  if (
    msg.includes("instructions_md") &&
    (msg.includes("check") || msg.includes("length"))
  ) {
    return {
      status: 400,
      body: {
        error: {
          code: "instructions_too_long",
          message: "Command instructions must be ≤ 8000 characters.",
        },
      },
    };
  }
  return {
    status: 500,
    body: {
      error: { code: "internal_error", message: "Unexpected error. Try again." },
    },
  };
}

export async function commandsList(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const sb = serverClientFromBearer(auth.access_token);
  const { data, error } = await sb.rpc("list_tenant_commands");
  if (error) {
    console.error("commands_list_failed", {
      tenant_id: auth.tenant_id,
      error_code: error.code,
      error_message: error.message,
    });
    const mapped = mapPostgresError(error);
    res.status(mapped.status).json(mapped.body);
    return;
  }
  res.json({ commands: data ?? [] });
}

export async function commandsUpsert(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const parsed = upsertBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: "bad_request",
        message: parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      },
    });
    return;
  }
  const { slug, name, description, instructions_md } = parsed.data;

  if (RESERVED_SLUGS.has(slug)) {
    res.status(400).json({
      error: {
        code: "reserved_slug",
        message: "That slug is reserved by a built-in command. Pick another.",
      },
    });
    return;
  }

  const sb = serverClientFromBearer(auth.access_token);
  const { data, error } = await sb.rpc("upsert_tenant_command", {
    p_slug: slug,
    p_name: name,
    p_description: description,
    p_instructions_md: instructions_md,
  });
  if (error) {
    console.error("commands_upsert_failed", {
      tenant_id: auth.tenant_id,
      slug,
      error_code: error.code,
      error_message: error.message,
    });
    const mapped = mapPostgresError(error);
    res.status(mapped.status).json(mapped.body);
    return;
  }
  const row = Array.isArray(data) ? data[0] : data;
  res.json({ command: row });
}

export async function commandsDelete(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const slug = req.params.slug;
  if (!slug || !SLUG_RE.test(slug)) {
    res.status(400).json({
      error: { code: "invalid_slug", message: "Bad slug in URL." },
    });
    return;
  }

  const sb = serverClientFromBearer(auth.access_token);
  const { error } = await sb.rpc("delete_tenant_command", { p_slug: slug });
  if (error) {
    console.error("commands_delete_failed", {
      tenant_id: auth.tenant_id,
      slug,
      error_code: error.code,
      error_message: error.message,
    });
    const mapped = mapPostgresError(error);
    res.status(mapped.status).json(mapped.body);
    return;
  }
  res.status(204).end();
}
