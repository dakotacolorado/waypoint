import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/** Who a bearer token belongs to. A write naming no `x-actor` is recorded under its name, or null for an admin. */
export interface Caller {
  name: string;
  admin: boolean;
}

export interface Auth {
  /** Null for a token nobody holds. */
  caller(token: string): Caller | null;
}

export interface TokenRecord {
  name: string;
  admin: boolean;
  createdAt: string;
}

export class TokenTakenError extends Error {}

const NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** One token for one caller: the tests', or a deployment's admin token from its environment. */
export const singleToken = (token: string, caller: Caller = { name: "admin", admin: true }): Auth => ({
  caller: (given) => (same(given, token) ? caller : null),
});

/** Tokens kept in the database as their hashes alone, so each is shown once, when made. */
export class Tokens implements Auth {
  private readonly db: DatabaseSync;
  /** Accepted as an admin's beside the stored ones, and never stored: a host keeps it in its own environment. */
  private readonly envAdmin: string | undefined;

  constructor(db: DatabaseSync, envAdmin?: string) {
    this.db = db;
    this.envAdmin = envAdmin || undefined;
    db.exec("CREATE TABLE IF NOT EXISTS tokens (name TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, admin INTEGER NOT NULL, created_at TEXT NOT NULL)");
  }

  caller(token: string): Caller | null {
    if (this.envAdmin !== undefined && same(token, this.envAdmin)) return { name: "admin", admin: true };
    const row = this.db.prepare("SELECT name, admin FROM tokens WHERE hash = ?").get(hash(token)) as { name: string; admin: number } | undefined;
    return row ? { name: row.name, admin: row.admin === 1 } : null;
  }

  /** The new token, which only its hash is kept of. */
  create(name: string, admin: boolean): string {
    if (!NAME.test(name)) throw new Error(`a token's name is lowercase letters, digits, '.', '_' and '-', up to 63, not "${name}"`);
    if (this.db.prepare("SELECT 1 FROM tokens WHERE name = ?").get(name)) throw new TokenTakenError(`a token named ${name} already exists: revoke it first`);
    const token = `wp_${randomBytes(24).toString("base64url")}`;
    this.db.prepare("INSERT INTO tokens (name, hash, admin, created_at) VALUES (?, ?, ?, ?)").run(name, hash(token), admin ? 1 : 0, new Date().toISOString());
    return token;
  }

  list(): TokenRecord[] {
    const rows = this.db.prepare("SELECT name, admin, created_at FROM tokens ORDER BY created_at, name").all() as { name: string; admin: number; created_at: string }[];
    return rows.map((row) => ({ name: row.name, admin: row.admin === 1, createdAt: row.created_at }));
  }

  /** Whether a token had that name. */
  revoke(name: string): boolean {
    return Number(this.db.prepare("DELETE FROM tokens WHERE name = ?").run(name).changes) > 0;
  }

  /** Whether any admin can reach it: a stored admin token, or the environment's. */
  hasAdmin(): boolean {
    return this.envAdmin !== undefined || this.db.prepare("SELECT 1 FROM tokens WHERE admin = 1").get() !== undefined;
  }
}
