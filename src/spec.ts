import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderApiReference, type Document } from "./api-doc.ts";
import { SPEC_PATH, WaypointApi } from "./api.ts";
import { singleToken } from "./auth.ts";
import { mcpDocument, renderMcp, renderMcpHtml } from "./mcp-doc.ts";
import { Store } from "./store.ts";

const at = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));

/** The contract and its docs, each committed so a change to them shows in review, and served as committed. */
export const SPEC_FILE = at("openapi.json");
export const API_DOC = at("docs/API.md");
export const API_PAGE = at("docs/index.html");
export const MCP_FILE = at("mcp.json");
export const MCP_DOC = at("docs/MCP.md");
export const MCP_PAGE = at("docs/mcp.html");

/** Fetched through the app, so the file cannot differ from what is served. */
export async function openApiDocument(): Promise<Document> {
  const api = new WaypointApi(Store.open(":memory:"), singleToken("spec"));
  return (await api.fetch(new Request(`http://local${SPEC_PATH}`))).json() as Promise<Document>;
}

if (import.meta.main) {
  const doc = await openApiDocument();
  writeFileSync(SPEC_FILE, `${JSON.stringify(doc, null, 2)}\n`);
  writeFileSync(API_DOC, renderApiReference(doc));
  execFileSync("npx", ["redocly", "build-docs", SPEC_FILE, "-o", API_PAGE], { stdio: "ignore" });
  const mcp = await mcpDocument();
  writeFileSync(MCP_FILE, `${JSON.stringify(mcp, null, 2)}\n`);
  writeFileSync(MCP_DOC, renderMcp(mcp));
  writeFileSync(MCP_PAGE, renderMcpHtml(mcp));
  console.log("wrote openapi.json, mcp.json and docs/");
}
