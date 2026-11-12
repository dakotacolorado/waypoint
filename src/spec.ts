import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SPEC_PATH, WorkTrackerApi } from "./api.ts";
import { singleToken } from "./auth.ts";
import { mcpDocument, renderMcp, renderMcpHtml } from "./mcp-doc.ts";
import { REFERENCE_FILE, renderReference } from "./skill.ts";
import { WorkItemStore } from "./store.ts";

/**
 * Writes `openapi.json`. Committed so clients generate without a deploy and
 * contract changes surface in review.
 */
export const SPEC_FILE = fileURLToPath(new URL("../openapi.json", import.meta.url));
/** The MCP server's contract, `tools/list` as served, beside its rendering in `docs/MCP.md`. */
export const MCP_FILE = fileURLToPath(new URL("../mcp.json", import.meta.url));
export const MCP_DOC = fileURLToPath(new URL("../docs/MCP.md", import.meta.url));
export const MCP_PAGE = fileURLToPath(new URL("../docs/mcp.html", import.meta.url));

/** Fetched through the app, so the file cannot differ from what is served. */
export async function openApiDocument(): Promise<unknown> {
  const api = new WorkTrackerApi(WorkItemStore.open(":memory:"), singleToken("spec"));
  return (await api.fetch(new Request(`http://local${SPEC_PATH}`))).json();
}

if (import.meta.main) {
  const doc = await openApiDocument();
  writeFileSync(SPEC_FILE, `${JSON.stringify(doc, null, 2)}\n`);
  writeFileSync(REFERENCE_FILE, renderReference(doc as Parameters<typeof renderReference>[0]));
  const mcp = await mcpDocument();
  writeFileSync(MCP_FILE, `${JSON.stringify(mcp, null, 2)}\n`);
  writeFileSync(MCP_DOC, renderMcp(mcp));
  writeFileSync(MCP_PAGE, renderMcpHtml(mcp));
  console.log(`wrote ${SPEC_FILE}, ${REFERENCE_FILE}, ${MCP_FILE} and ${MCP_DOC}`);
}
