import { WaypointApi } from "./api.ts";
import { Tokens } from "./auth.ts";
import { buildOf, PACKAGE_VERSION } from "./build.ts";
import { Store } from "./store.ts";

export interface Config {
  /** The SQLite file; `:memory:` keeps nothing past the process. */
  db: string;
  /** Where people reach it: its public HTTPS address behind a proxy, else its own. */
  publicUrl: string;
  /** An admin token taken from the environment, never stored. */
  adminToken?: string;
}

export interface Running {
  api: WaypointApi;
  store: Store;
  tokens: Tokens;
  /** Closes the database. */
  close(): void;
}

export function start(config: Config): Running {
  const store = Store.open(config.db);
  const tokens = new Tokens(store.db, config.adminToken);
  const api = new WaypointApi(store, tokens, { about: { version: PACKAGE_VERSION, commit: buildOf().commit }, publicUrl: config.publicUrl });
  return { api, store, tokens, close: () => store.db.close() };
}
