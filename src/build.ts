import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface Build {
  version: number;
  commit: string;
}

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The package's version, as `package.json` gives it. */
export const PACKAGE_VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

/** A checkout's commit count and sha, `-dirty` when its tree differs from its commit. */
export function gitVersion(cwd: string = ROOT): Build {
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  try {
    const dirty = git("status", "--porcelain").length > 0;
    return { version: Number(git("rev-list", "--count", "HEAD")), commit: git("rev-parse", "HEAD") + (dirty ? "-dirty" : "") };
  } catch {
    return { version: 0, commit: "unknown" };
  }
}

/**
 * The commit this copy was built from: `build.json`, written by `npm run
 * build` beside the compiled code, since a package installed from npm has no
 * git to ask; else the checkout it runs in.
 */
export function buildOf(): Build {
  const stamped = new URL("./build.json", import.meta.url);
  if (existsSync(stamped)) return JSON.parse(readFileSync(stamped, "utf8")) as Build;
  return gitVersion();
}

if (import.meta.main) {
  const [file] = process.argv.slice(2);
  if (!file) throw new Error("usage: node src/build.ts <file>");
  (await import("node:fs")).writeFileSync(file, `${JSON.stringify(gitVersion())}\n`);
}
