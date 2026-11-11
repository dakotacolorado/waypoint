import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WorkTrackerApi } from "./api.ts";
import { Assigner } from "./assignment.ts";
import { Tokens } from "./auth.ts";
import { Dispatcher, FleetClient, type WorkersConfig } from "./dispatch.ts";
import { gitVersion, readSkill, SKILL_DIR } from "./skill.ts";
import { WorkItemStore } from "./store.ts";

export interface Config {
  /** The SQLite file; `:memory:` keeps nothing past the process. */
  db: string;
  /** Where links to items open: the UI's address, else this service's own. */
  uiUrl: string;
  /** An admin token taken from the environment, never stored. */
  adminToken?: string;
  /** worker-service, which starts agents: without it the queue waits and nothing calls out. */
  workers?: WorkersConfig;
  /** How often the dispatcher runs, while `workers` is given. */
  dispatchEveryMs?: number;
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
  /** Stops the dispatcher's timer and closes the database. */
  close(): void;
}

export function start(config: Config): Running {
  const store = WorkItemStore.open(config.db);
  const tokens = new Tokens(store.db, config.adminToken);
  const build = buildOf();
  const skill = () => readSkill(SKILL_DIR, build.version, build.commit, config.uiUrl);
  const fleet = config.workers && new FleetClient(config.workers.url, config.workers.token);
  const assigner = fleet && (() => new Assigner(store, fleet, config.uiUrl));
  const api = new WorkTrackerApi(store, tokens, {
    about: { version: PACKAGE_VERSION, commit: build.commit },
    skill,
    assigner,
    fleet: fleet && (() => fleet),
  });
  let timer: NodeJS.Timeout | undefined;
  if (fleet) {
    const dispatcher = new Dispatcher(store, fleet, new Assigner(store, fleet, config.uiUrl));
    let running = false;
    const run = async () => {
      if (running) return;
      running = true;
      try {
        console.log(JSON.stringify({ dispatched: await dispatcher.run() }));
      } catch (err) {
        console.error("dispatch failed:", err);
      } finally {
        running = false;
      }
    };
    timer = setInterval(run, config.dispatchEveryMs ?? 5 * 60_000);
    timer.unref();
  }
  return {
    api,
    store,
    tokens,
    close() {
      clearInterval(timer);
      store.db.close();
    },
  };
}
