export function productBuilderStageScope(isBuildStage: boolean): {
  writeRule: string;
  depthBaseline: string;
} {
  if (isBuildStage) {
    return {
      writeRule: "Generate the whole app — multiple files, real screens.",
      depthBaseline: `### STRUCTURE & DEPTH BASELINE (a real multi-page app — the FULL feature set, not the minimum)
Build the WHOLE product the idea + PRD describe, not the smallest demo of it:
1. Multiple real routes/pages with working navigation via the app-router (\`app/<route>/page.tsx\`) — e.g. dashboard/list, detail, create/edit, settings/auth. A real product is almost never one page.
2. Implement EVERY primary feature the idea + PRD name, end-to-end (create / read / update / delete where it makes sense), wired to the database — not placeholder buttons or "coming soon" stubs.
3. For each core entity the idea implies, provide the real screens to manage it (list + detail + create/edit), reading and writing the database.
4. Match the ambition of the idea: a "project management app" needs projects + tasks + assignment + a dashboard, all persisted and navigable — never a single static page.`,
    };
  }
  return {
    writeRule: "Generate the app skeleton this stage asks for — multiple files, real screens.",
    depthBaseline: `### STRUCTURE BASELINE (scaffold — the skeleton the build stage extends)
This stage and the build stage after it each have their own time budget. Building every feature here runs this stage out of time and the whole run is lost, so keep to the skeleton:
1. Every route/page the idea + PRD imply, with working app-router navigation (\`app/<route>/page.tsx\`), the shared layout, and the data model with its migration.
2. ONE primary flow working end-to-end against the database: the one the idea is about. The other pages show their real layout and components with real or empty data; their remaining create/edit/settings flows are the build stage's job.
3. No "coming soon" pages: an unfinished page shows its real structure with an empty state.`,
  };
}
