
import { z } from "zod";
import { figmaGet } from "./_client";
import type { ToolSpec } from "@/services/tools/types";

const MAX_ITEMS = 200;

const inputSchema = z
  .object({
    project_id: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe("A Figma project id (from a project URL). Returns the files inside that project."),
    team_id: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe(
        "A Figma team id (from a team URL). Returns the PROJECTS inside that team, not files directly — " +
          "call this tool again with one of the returned project ids to see its files.",
      ),
  })
  .refine((v) => Boolean(v.project_id) !== Boolean(v.team_id), {
    message: "Provide exactly one of project_id or team_id, not both and not neither.",
  });

type FilesResponse = {
  name?: unknown;
  files?: Array<{ key?: unknown; name?: unknown; last_modified?: unknown }>;
};

type ProjectsResponse = {
  name?: unknown;
  projects?: Array<{ id?: unknown; name?: unknown }>;
};

export const figmaListFilesTool: ToolSpec = {
  name: "figma_list_files",
  effect: "read",
  description:
    "List what the connected Figma personal access token can see. Pass project_id to list the FILES inside " +
    "a Figma project, or team_id to list the PROJECTS inside a Figma team (team_id does NOT return files " +
    "directly — call this tool again with one of the returned project ids to get its files). Use " +
    "figma_get_file to read one specific file's structure. Throws figma_not_connected if the operator has " +
    "not connected Figma yet.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { project_id, team_id } = inputSchema.parse(input);

    if (project_id) {
      const data = (await figmaGet(
        ctx.tenant_id,
        `/v1/projects/${encodeURIComponent(project_id)}/files`,
      )) as FilesResponse;
      const files = Array.isArray(data.files) ? data.files : [];
      const truncated = files.length > MAX_ITEMS;
      return {
        kind: "files" as const,
        project_id,
        project_name: typeof data.name === "string" ? data.name : null,
        files: (truncated ? files.slice(0, MAX_ITEMS) : files).map((f) => ({
          file_key: typeof f.key === "string" ? f.key : null,
          name: typeof f.name === "string" ? f.name : null,
          last_modified: typeof f.last_modified === "string" ? f.last_modified : null,
        })),
        count: files.length,
        truncated,
        ...(truncated ? { note: `Showing the first ${MAX_ITEMS} files.` } : {}),
      };
    }

    const data = (await figmaGet(
      ctx.tenant_id,
      `/v1/teams/${encodeURIComponent(team_id as string)}/projects`,
    )) as ProjectsResponse;
    const projects = Array.isArray(data.projects) ? data.projects : [];
    const truncated = projects.length > MAX_ITEMS;
    return {
      kind: "projects" as const,
      team_id,
      projects: (truncated ? projects.slice(0, MAX_ITEMS) : projects).map((p) => ({
        project_id: typeof p.id === "string" ? p.id : null,
        name: typeof p.name === "string" ? p.name : null,
      })),
      count: projects.length,
      truncated,
      note: "This lists PROJECTS in the team, not files. Call figma_list_files again with a project_id to see its files.",
    };
  },
};
