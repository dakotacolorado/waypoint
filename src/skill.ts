import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** The skill this service's client is installed as, under a worker's `skills/`. */
export const SKILL_NAME = "work-tracker";

/**
 * The client a worker calls this service with, as written into its
 * `skills/<name>/`. Only `bin/` and `reference/`: when to use it and how to
 * work stay in the `SKILL.md` that document-service's `global` holds.
 */
export const SKILL_DIR = fileURLToPath(new URL("../skill", import.meta.url));
export const REFERENCE_FILE = join(SKILL_DIR, "reference", "api.md");

export interface SkillFile {
  path: string;
  content: string;
  executable: boolean;
}

export interface Skill {
  key: string;
  version: number;
  commit: string;
  files: SkillFile[];
}

/** Stands in a skill file for the address of the UI this deployment's items open in. */
export const UI_URL_MARK = "@WT_UI_URL@";

/** Every file under `dir`, as a worker gets it, read from disk at each call, with `UI_URL_MARK` filled in. */
export function readSkill(dir: string, version: number, commit: string, ui: string): Skill {
  const walk = (at: string): string[] =>
    readdirSync(at, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(at, e.name)) : [join(at, e.name)],
    );
  const files = walk(dir)
    .sort()
    .map((file) => ({
      path: `skills/${SKILL_NAME}/${relative(dir, file).split("\\").join("/")}`,
      content: readFileSync(file, "utf8").replaceAll(UI_URL_MARK, ui),
      // By folder, not mode: an npm tarball or a copy need not keep a file's mode.
      executable: relative(dir, file).startsWith("bin"),
    }));
  return { key: SKILL_NAME, version, commit, files };
}

/** The deployed tree's commit count and sha, `-dirty` when it differs from its commit. */
export function gitVersion(cwd: string): { version: number; commit: string } {
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  try {
    const dirty = git("status", "--porcelain").length > 0;
    return { version: Number(git("rev-list", "--count", "HEAD")), commit: git("rev-parse", "HEAD") + (dirty ? "-dirty" : "") };
  } catch {
    return { version: 0, commit: "unknown" };
  }
}

type Schema = {
  $ref?: string;
  type?: string | string[];
  enum?: unknown[];
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
  description?: string;
  nullable?: boolean;
  format?: string;
  anyOf?: Schema[];
  oneOf?: Schema[];
  allOf?: Schema[];
  additionalProperties?: Schema | boolean;
  minLength?: number;
  maxLength?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
};
type Parameter = { name: string; in: string; required?: boolean; description?: string; schema?: Schema };
type Operation = {
  tags?: string[];
  summary?: string;
  description?: string;
  parameters?: Parameter[];
  requestBody?: { description?: string; content?: Record<string, { schema?: Schema }> };
  responses?: Record<string, { description?: string; content?: Record<string, { schema?: Schema }> }>;
};
type Document = {
  info?: { title?: string; description?: string };
  paths: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, Schema> };
};

const METHODS = ["get", "post", "put", "patch", "delete"];
const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
const refName = (ref: string) => ref.split("/").pop()!;

/** One schema as a short type: a component by name, an enum by its values. */
function type(s: Schema | undefined): string {
  if (!s) return "any";
  if (s.$ref) return `\`${refName(s.$ref)}\``;
  const or = s.anyOf ?? s.oneOf;
  if (or) return or.map(type).join(" or ");
  if (s.allOf) return s.allOf.map(type).join(" and ");
  if (s.enum) return s.enum.map((v) => `\`${JSON.stringify(v).replace(/^"|"$/g, "")}\``).join(", ");
  let t: string;
  if (s.type === "array") t = `${type(s.items)}[]`;
  else if (s.type === "object" && s.properties) {
    const required = new Set(s.required ?? []);
    t = `{${Object.entries(s.properties).map(([k, v]) => `${k}${required.has(k) ? "" : "?"}: ${type(v)}`).join(", ")}}`;
  }
  else if (s.type === "object" && typeof s.additionalProperties === "object") t = `map of ${type(s.additionalProperties)}`;
  else t = [s.type ?? "any"].flat().join(" or ") + (s.format ? ` (${s.format})` : "");
  const limits = [
    s.minLength !== undefined && `min ${s.minLength}`,
    s.maxLength !== undefined && `max ${s.maxLength}`,
    s.maxItems !== undefined && `at most ${s.maxItems}`,
    s.minimum !== undefined && `≥ ${s.minimum}`,
    s.maximum !== undefined && `≤ ${s.maximum}`,
  ].filter(Boolean);
  return t + (limits.length ? ` (${limits.join(", ")})` : "") + (s.nullable ? " or null" : "");
}

function fields(s: Schema): string[] {
  const required = new Set(s.required ?? []);
  return [
    "| Field | Type | |",
    "| --- | --- | --- |",
    ...Object.entries(s.properties ?? {}).map(
      ([name, p]) => `| \`${name}\`${required.has(name) ? "" : "?"} | ${cell(type(p))} | ${cell(p.description ?? "")} |`,
    ),
  ];
}

const body = (content: Record<string, { schema?: Schema }> | undefined) => {
  const schema = content && Object.values(content)[0]?.schema;
  return schema ? type(schema) : null;
};

/**
 * A worker's reference to the API, from its OpenAPI document: every operation
 * but `meta`'s, with its parameters, body and answers, then every named schema's fields.
 * Short enough for a worker's context, where the full rendering is not.
 */
export function renderReference(doc: Document): string {
  const out = [
    `# ${doc.info?.title ?? "API"} API`,
    "",
    `Generated from this deployment's \`openapi.json\`. \`bin/\` adds the address, the bearer token and \`claimed-by\`, so a path is all a call needs. A field marked \`?\` is optional.`,
    "",
  ];
  if (doc.info?.description) out.push(doc.info.description, "");
  const rendered: Operation[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of METHODS) {
      const op = item[method];
      // Liveness and the skill itself are for the platform, not a worker's calls.
      if (!op || op.tags?.includes("meta")) continue;
      rendered.push(op);
      out.push(`## ${method.toUpperCase()} ${path}`, "");
      if (op.summary) out.push(op.summary + ".", "");
      if (op.description) out.push(op.description, "");
      const params = (op.parameters ?? []).filter((p) => p.in !== "header");
      if (params.length) {
        out.push("| Parameter | In | Type | |", "| --- | --- | --- | --- |");
        for (const p of params) {
          out.push(`| \`${p.name}\`${p.required ? "" : "?"} | ${p.in} | ${cell(type(p.schema))} | ${cell(p.description ?? p.schema?.description ?? "")} |`);
        }
        out.push("");
      }
      const sent = body(op.requestBody?.content);
      if (sent) out.push(`Body: ${sent}${op.requestBody?.description ? `. ${op.requestBody.description}` : ""}`, "");
      for (const [status, r] of Object.entries(op.responses ?? {})) {
        const got = body(r.content);
        out.push(`- ${status}: ${r.description ?? ""}${got ? ` → ${got}` : ""}`);
      }
      out.push("");
    }
  }
  const all = doc.components?.schemas ?? {};
  const used = new Set<string>();
  const reach = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(reach);
    if (!value || typeof value !== "object") return;
    for (const [k, v] of Object.entries(value)) {
      if (k === "$ref" && typeof v === "string" && !used.has(refName(v))) {
        used.add(refName(v));
        reach(all[refName(v)]);
      } else reach(v);
    }
  };
  reach(rendered);
  const schemas = Object.entries(all).filter(([name]) => used.has(name));
  if (schemas.length) out.push("# Schemas", "");
  for (const [name, s] of schemas) {
    out.push(`## ${name}`, "");
    if (s.description) out.push(s.description, "");
    if (s.allOf) {
      const refs = s.allOf.filter((part) => part.$ref).map(type);
      const own = s.allOf.filter((part) => part.properties);
      if (refs.length) out.push(`Every field of ${refs.join(" and ")}${own.length ? ", and:" : "."}`, "");
      for (const part of own) out.push(...fields(part), "");
    } else out.push(...(s.properties ? fields(s) : [type(s)]), "");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
