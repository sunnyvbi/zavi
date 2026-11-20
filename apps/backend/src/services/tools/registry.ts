
import { linkedinTrackingLinkTool } from "@/services/tools/social/linkedin_tracking_link";
import { z, ZodTypeAny } from "zod";
import type { ToolSpec } from "./types";
import { listChannelsTool } from "./slack/list_channels";
import { getChannelHistoryTool } from "./slack/get_channel_history";
import { provisionRepoTool } from "./provision/repo";
import { provisionHostingTool } from "./provision/hosting";
import { provisionDomainTool } from "./provision/domain";
import { provisionEmailTool } from "./provision/email";
import { proposeOutboundEmailTool } from "./outbound/propose_email";
import { listEmailListsTool } from "./outbound/list_email_lists";
import { emailProposeCampaignTool } from "./email/propose_campaign";
import { emailListPlanTool, emailPlanSendTool } from "./email/plan_send";
import { socialProposePostTool } from "./social/propose_post";
import { socialProposeStandingOrderTool } from "./social/propose_standing_order";
import { socialListPostsTool } from "./social/list_posts";
import { generatedVideoProposeTool } from "./generated-video/propose_video";
import { generatedVideoAnimateTool } from "./generated-video/animate_image";
import { seoProposePrTool } from "./seo/propose_pr";
import { geoProposePrTool } from "./geo/propose_pr";
import { marketplaceIntelligenceTool } from "./growth/marketplace_intelligence";
import { creatorMessageTool } from "./creators/creator_message";
import { creatorOfferTool } from "./creators/creator_offer";
import { creatorBookPackageTool } from "./creators/creator_book_package";

const TOOL_NAME_RE = /^[a-zA-Z0-9_-]+$/;

const tools: Record<string, ToolSpec> = {};

export function registerTool(spec: ToolSpec): void {
  if (!TOOL_NAME_RE.test(spec.name)) {
    throw new Error(
      `tool name "${spec.name}" must match ${TOOL_NAME_RE.source} (Anthropic constraint)`,
    );
  }
  if (tools[spec.name]) {
    throw new Error(`tool already registered: ${spec.name}`);
  }
  tools[spec.name] = spec;
}

registerTool(listChannelsTool);
registerTool(getChannelHistoryTool);
registerTool(provisionRepoTool as ToolSpec);
registerTool(provisionHostingTool as ToolSpec);
registerTool(provisionDomainTool as ToolSpec);
registerTool(provisionEmailTool as ToolSpec);
registerTool(proposeOutboundEmailTool as ToolSpec);
registerTool(emailProposeCampaignTool as ToolSpec);
registerTool(emailPlanSendTool as ToolSpec);
registerTool(emailListPlanTool as ToolSpec);
registerTool(listEmailListsTool as ToolSpec);
registerTool(socialProposePostTool);
registerTool(socialProposeStandingOrderTool);
registerTool(socialListPostsTool);
registerTool(linkedinTrackingLinkTool);
registerTool(generatedVideoProposeTool);
registerTool(generatedVideoAnimateTool);
registerTool(seoProposePrTool);
registerTool(geoProposePrTool);
registerTool(marketplaceIntelligenceTool as ToolSpec);
registerTool(creatorMessageTool);
registerTool(creatorOfferTool);
registerTool(creatorBookPackageTool);

export function byName(name: string): ToolSpec | null {
  return tools[name] ?? null;
}

export function listTools(): ToolSpec[] {
  return Object.values(tools);
}

export type AnthropicTool = {
  name: string;
  description: string;
  input_schema: { type: "object"; properties?: unknown; [k: string]: unknown };
};

export function toAnthropicTool(spec: ToolSpec): AnthropicTool {
  const schema = zodToJsonSchema(spec.input_schema);
  if (schema.type !== "object") {
    throw new Error(
      `Tool "${spec.name}" must have a top-level z.object() input_schema (got "${String(schema.type)}").`,
    );
  }
  return {
    name: spec.name,
    description: spec.description,
    input_schema: schema as { type: "object"; properties?: unknown; [k: string]: unknown },
  };
}

type JsonSchema = Record<string, unknown>;

type ZodDef = { type: string; [k: string]: unknown };
function zodDef(schema: ZodTypeAny): ZodDef {
  return (schema as unknown as { _zod: { def: ZodDef } })._zod.def;
}

export function zodToJsonSchema(schema: ZodTypeAny): JsonSchema {
  const def = zodDef(schema);
  switch (def.type) {
    case "string":
      return { type: "string" };
    case "number": {
      const numDef = def as unknown as {
        checks?: Array<{ _zod?: { def?: ChkDef }; def?: ChkDef }>;
      };
      type ChkDef = { check?: string; value?: number; format?: string };
      const out: JsonSchema = { type: "number" };
      const checkDefs = (numDef.checks ?? []).map((c) => c._zod?.def ?? c.def ?? {});
      const isInt = checkDefs.some(
        (c) => c.check === "number_format" && (c.format === "int" || c.format === "safeint"),
      );
      if (isInt) out.type = "integer";
      const min = checkDefs.find((c) => c.check === "greater_than");
      const max = checkDefs.find((c) => c.check === "less_than");
      if (min?.value !== undefined) out.minimum = min.value;
      if (max?.value !== undefined) out.maximum = max.value;
      return out;
    }
    case "boolean":
      return { type: "boolean" };
    case "enum": {
      const enumDef = def as unknown as { entries: Record<string, string> };
      return { type: "string", enum: Object.values(enumDef.entries) };
    }
    case "array": {
      const arrDef = def as unknown as { element: ZodTypeAny };
      return { type: "array", items: zodToJsonSchema(arrDef.element) };
    }
    case "optional": {
      const optDef = def as unknown as { innerType: ZodTypeAny };
      return zodToJsonSchema(optDef.innerType);
    }
    case "catch": {
      const catchDef = def as unknown as { innerType: ZodTypeAny };
      return zodToJsonSchema(catchDef.innerType);
    }
    case "default": {
      const defDef = def as unknown as { innerType: ZodTypeAny; defaultValue: unknown };
      const inner = zodToJsonSchema(defDef.innerType);
      try {
        const dv = defDef.defaultValue;
        inner.default = typeof dv === "function" ? (dv as () => unknown)() : dv;
      } catch {
      }
      return inner;
    }
    case "object": {
      const objDef = def as unknown as {
        shape: Record<string, ZodTypeAny>;
      };
      const shape = objDef.shape;
      const properties: JsonSchema = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value);
        const inner = zodDef(value).type;
        if (inner !== "optional" && inner !== "default" && inner !== "catch") {
          required.push(key);
        }
      }
      const out: JsonSchema = { type: "object", properties };
      if (required.length > 0) out.required = required;
      return out;
    }
    case "literal": {
      const litDef = def as unknown as { values: Array<string | number | boolean> };
      return { const: litDef.values[0] };
    }
    case "record": {
      const recDef = def as unknown as {
        valueType: ZodTypeAny;
      };
      return {
        type: "object",
        additionalProperties: zodToJsonSchema(recDef.valueType),
      };
    }
    case "unknown":
    case "any": {
      return {};
    }
    case "pipe": {
      const pipeDef = def as unknown as { in: ZodTypeAny; out: ZodTypeAny };
      const inIsTransform = zodDef(pipeDef.in).type === "transform";
      return zodToJsonSchema(inIsTransform ? pipeDef.out : pipeDef.in);
    }
    case "union": {
      const duDef = def as unknown as { options: ZodTypeAny[] };
      const branches = duDef.options.map((o) => zodToJsonSchema(o));
      if (branches.every((b) => b.type === "object")) {
        return { type: "object", oneOf: branches };
      }
      return { anyOf: branches };
    }
    case "null": {
      return { type: "null" };
    }
    default:
      throw new Error(
        `zodToJsonSchema: unsupported zod type "${def.type}". Add support in services/tools/registry.ts when you need it.`,
      );
  }
}
