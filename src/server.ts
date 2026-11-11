import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WorkTrackerApi } from "./api.ts";
import { Tokens } from "./auth.ts";
import { gitVersion } from "./skill.ts";
import { WorkItemStore } from "./store.ts";

export interface Config {
  /** The SQLite file; `:memory:` keeps nothing past the process. */
  db: string;
  /** An admin token taken from the environment, never stored. */
  adminToken?: string;
}

export interface Build {
  version: number;
  commit: string;
}

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The package's version, as `package.json` gives it. */
export const PACKAGE_VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

/**
 * The commit this copy was built from: `build.json`, written by `npm run
 * build` beside the compiled code, else the checkout it runs in.
 */
export function buildOf(): Build {
  const stamped = new URL("./build.json", import.meta.url);
  if (existsSync(stamped)) return JSON.parse(readFileSync(stamped, "utf8")) as Build;
  return gitVersion(ROOT);
}

export interface Running {
  api: WorkTrackerApi;
  store: WorkItemStore;
  tokens: Tokens;
  /** Closes the database. */
  close(): void;
}

export function start(config: Config): Running {
  const store = WorkItemStore.open(config.db);
  const tokens = new Tokens(store.db, config.adminToken);
  const build = buildOf();
  const api = new WorkTrackerApi(store, tokens, { about: { version: PACKAGE_VERSION, commit: build.commit } });
  return {
    api,
    store,
    tokens,
    close() {
      store.db.close();
    },
  };
}
