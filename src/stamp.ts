import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gitVersion } from "./skill.ts";

/** Writes the commit a build is made from beside it, since a package installed from npm has no git to ask. */
const [file] = process.argv.slice(2);
if (!file) throw new Error("usage: node src/stamp.ts <file>");
writeFileSync(file, `${JSON.stringify(gitVersion(fileURLToPath(new URL("..", import.meta.url))))}\n`);
