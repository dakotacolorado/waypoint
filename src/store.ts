import { randomUUID } from "node:crypto";
import { renameSync, rmSync } from "node:fs";
import { backup, DatabaseSync } from "node:sqlite";
import { changes, ConflictError, NotFoundError, Tasks, type HistoryEntry, type Task, type TaskInput } from "./domain.ts";
import { Labels, type Label, type LabelInput } from "./labels.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, record TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS labels (id TEXT PRIMARY KEY, record TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS task_history (seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, record TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS task_history_task ON task_history (task_id, seq);
CREATE TABLE IF NOT EXISTS comments (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL, record TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS comments_task ON comments (task_id, seq);
CREATE TABLE IF NOT EXISTS client_tokens (operation TEXT NOT NULL, token TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY (operation, token));
`;

/**
 * Each changes stored records to the shape the code now reads, once, in
 * order: the count applied is the meta key `migrations`. Append only.
 */
const MIGRATIONS: ((db: DatabaseSync) => void)[] = [
  // Tasks gain `verification`.
  (db) => db.exec("UPDATE tasks SET record = json_set(record, '$.verification', json('null')) WHERE json_type(record, '$.verification') IS NULL"),
];

export interface Comment {
  id: string;
  taskId: string;
  author: string | null;
  body: string;
  createdAt: string;
}

/** What one write stores and removes, all or none. */
interface Write {
  tasks?: Task[];
  removeTask?: string;
  labels?: Label[];
  removeLabel?: string;
  history?: HistoryEntry[];
  comment?: Comment;
  /** The client token a create was made with, and the id it made. */
  token?: { operation: string; token: string; result: string };
}

interface Snapshot {
  tasks: Tasks;
  labels: Labels;
  version: number;
}

/** The changes a request asks of a task, its references still as given. */
export interface TaskRequest extends Omit<TaskInput, "labels" | "dependsOn"> {
  dependsOn?: string[];
  labels?: string[];
}

/**
 * Tasks, labels, history and comments in one SQLite database, each record
 * its JSON. Every write is decided against a read of every task and label,
 * and commits only if no other write landed since; otherwise it is decided
 * again against a fresh read, so a field a request leaves out keeps its value
 * as it stands when the write lands.
 */
export class Store {
  static readonly ATTEMPTS = 5;

  readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    db.exec(SCHEMA);
    Store.migrate(db);
  }

  private static migrate(db: DatabaseSync): void {
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = db.prepare("SELECT value FROM meta WHERE key = 'migrations'").get() as { value: string } | undefined;
      const applied = row ? Number(row.value) : 0;
      for (const migration of MIGRATIONS.slice(applied)) migration(db);
      db.prepare("INSERT INTO meta (key, value) VALUES ('migrations', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(String(MIGRATIONS.length));
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  /** The database at `path`, made if absent; `:memory:` for one that lasts as long as the process. */
  static open(path: string): Store {
    return new Store(new DatabaseSync(path));
  }

  async tasks(): Promise<Tasks> {
    return (await this.snapshot()).tasks;
  }

  async labels(): Promise<Labels> {
    return (await this.snapshot()).labels;
  }

  async createTask(input: TaskRequest, actor: string | null, clientToken?: string): Promise<Task> {
    return this.decide(({ tasks, labels }) => {
      const made = this.made(tasks, "CreateTask", clientToken);
      if (made) return { result: made };
      const now = new Date().toISOString();
      const task = tasks.apply(null, this.resolved(tasks, labels, input), actor, now);
      tasks.check(null, task);
      return {
        result: task,
        write: {
          tasks: [task],
          history: [{ taskId: task.id, action: "created", changes: changes(null, task), actor, at: now }],
          ...(clientToken && { token: { operation: "CreateTask", token: clientToken, result: task.id } }),
        },
      };
    });
  }

  async updateTask(ref: string, input: TaskRequest, actor: string | null): Promise<Task> {
    return this.decide(({ tasks, labels }) => {
      const current = tasks.find(ref);
      const now = new Date().toISOString();
      const next = tasks.apply(current, this.resolved(tasks, labels, input), actor, now);
      tasks.check(current, next);
      const changed = changes(current, next);
      if (!changed.length) return { result: current };
      return { result: next, write: { tasks: [next], history: [{ taskId: next.id, action: "updated", changes: changed, actor, at: now }] } };
    });
  }

  async deleteTask(ref: string, actor: string | null): Promise<void> {
    await this.decide(({ tasks }) => {
      const current = tasks.find(ref);
      tasks.checkDelete(current.id);
      const at = new Date().toISOString();
      return { result: undefined, write: { removeTask: current.id, history: [{ taskId: current.id, action: "deleted", changes: changes(current, null), actor, at }] } };
    });
  }

  /** Oldest first. A deleted task's is kept, read by its full id. */
  async history(ref: string): Promise<HistoryEntry[]> {
    const id = await this.taskId(ref);
    return this.rows("SELECT record FROM task_history WHERE task_id = ? ORDER BY seq", id) as unknown as HistoryEntry[];
  }

  async comments(ref: string): Promise<Comment[]> {
    const id = (await this.tasks()).find(ref).id;
    return this.rows("SELECT record FROM comments WHERE task_id = ? ORDER BY seq", id) as unknown as Comment[];
  }

  async createComment(ref: string, body: string, author: string | null, clientToken?: string): Promise<Comment> {
    return this.decide(({ tasks }) => {
      const task = tasks.find(ref);
      const made = clientToken ? this.tokenResult("CreateComment", clientToken) : null;
      if (made) {
        const [comment] = this.rows("SELECT record FROM comments WHERE id = ?", made) as unknown as Comment[];
        if (comment) return { result: comment };
      }
      const comment: Comment = { id: randomUUID(), taskId: task.id, author, body, createdAt: new Date().toISOString() };
      return { result: comment, write: { comment, ...(clientToken && { token: { operation: "CreateComment", token: clientToken, result: comment.id } }) } };
    });
  }

  async createLabel(input: LabelInput, clientToken?: string): Promise<Label> {
    return this.decide(({ labels }) => {
      const made = clientToken ? this.tokenResult("CreateLabel", clientToken) : null;
      if (made) {
        const existing = labels.all().find((label) => label.id === made);
        if (existing) return { result: existing };
      }
      const label = labels.create(input);
      return { result: label, write: { labels: [label], ...(clientToken && { token: { operation: "CreateLabel", token: clientToken, result: label.id } }) } };
    });
  }

  async updateLabel(ref: string, patch: Partial<LabelInput>): Promise<Label> {
    return this.decide(({ labels }) => {
      const next = labels.updated(labels.find(ref), patch);
      return { result: next, write: { labels: [next] } };
    });
  }

  /** Takes the label off every task that has it, each recorded in its history. */
  async deleteLabel(ref: string, actor: string | null): Promise<void> {
    await this.decide(({ tasks, labels }) => {
      const label = labels.find(ref);
      const at = new Date().toISOString();
      const had = tasks.all().filter((task) => task.labels.includes(label.id));
      const untagged = had.map((task) => ({ ...task, labels: task.labels.filter((id) => id !== label.id), updatedAt: at }));
      const history = untagged.map((task, i) => ({ taskId: task.id, action: "updated" as const, changes: changes(had[i]!, task), actor, at }));
      return { result: undefined, write: { removeLabel: label.id, tasks: untagged, history } };
    });
  }

  /**
   * Copies the database to `file` by SQLite's online backup, so it is
   * consistent while writes go on; written beside it and renamed in, so
   * `file` is never a partial copy. How many pages it copied.
   */
  async backup(file: string): Promise<number> {
    const partial = `${file}.partial`;
    rmSync(partial, { force: true });
    try {
      const pages = await backup(this.db, partial);
      renameSync(partial, file);
      return pages;
    } catch (err) {
      rmSync(partial, { force: true });
      throw err;
    }
  }

  /** `input` with its task and label references as ids. */
  private resolved(tasks: Tasks, labels: Labels, input: TaskRequest): TaskInput {
    return { ...input, ...(input.dependsOn && { dependsOn: tasks.ids(input.dependsOn) }), ...(input.labels && { labels: labels.ids(input.labels) }) };
  }

  /** The task a create with this client token already made, if it still exists. */
  private made(tasks: Tasks, operation: string, clientToken?: string): Task | null {
    const id = clientToken ? this.tokenResult(operation, clientToken) : null;
    return id ? (tasks.get(id) ?? null) : null;
  }

  /** A deleted task keeps its history: a full id is taken as given. */
  private async taskId(ref: string): Promise<string> {
    try {
      return (await this.tasks()).find(ref).id;
    } catch (err) {
      if (err instanceof NotFoundError && this.db.prepare("SELECT 1 FROM task_history WHERE task_id = ?").get(ref)) return ref;
      throw err;
    }
  }

  /** Runs `decision` against fresh reads until one commits. */
  private async decide<T>(decision: (snapshot: Snapshot) => { result: T; write?: Write }): Promise<T> {
    for (let attempt = 0; attempt < Store.ATTEMPTS; attempt++) {
      const snapshot = await this.snapshot();
      const { result, write } = decision(snapshot);
      if (!write) return result;
      if (this.commit(snapshot.version, write)) return result;
    }
    throw new ConflictError("other writes kept landing first; retry");
  }

  // `snapshot`, `commit` and `storedVersion` are the persistence a test double may hold or bend.

  protected async snapshot(): Promise<Snapshot> {
    const version = this.storedVersion();
    return {
      tasks: new Tasks(this.rows("SELECT record FROM tasks ORDER BY rowid") as unknown as Task[]),
      labels: new Labels(this.rows("SELECT record FROM labels") as unknown as Label[]),
      version,
    };
  }

  /** All or none, and only if nothing else has committed since `version` was read. */
  protected commit(version: number, write: Write): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.storedVersion() !== version) {
        this.db.exec("ROLLBACK");
        return false;
      }
      const upsert = (table: string) => this.db.prepare(`INSERT INTO ${table} (id, record) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET record = excluded.record`);
      this.db.prepare("INSERT INTO meta (key, value) VALUES ('version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(String(version + 1));
      for (const task of write.tasks ?? []) upsert("tasks").run(task.id, JSON.stringify(task));
      for (const label of write.labels ?? []) upsert("labels").run(label.id, JSON.stringify(label));
      if (write.removeTask) this.db.prepare("DELETE FROM tasks WHERE id = ?").run(write.removeTask);
      if (write.removeLabel) this.db.prepare("DELETE FROM labels WHERE id = ?").run(write.removeLabel);
      for (const entry of write.history ?? []) this.db.prepare("INSERT INTO task_history (task_id, record) VALUES (?, ?)").run(entry.taskId, JSON.stringify(entry));
      if (write.comment) this.db.prepare("INSERT INTO comments (id, task_id, record) VALUES (?, ?, ?)").run(write.comment.id, write.comment.taskId, JSON.stringify(write.comment));
      if (write.token) this.db.prepare("INSERT INTO client_tokens (operation, token, result) VALUES (?, ?, ?)").run(write.token.operation, write.token.token, write.token.result);
      this.db.exec("COMMIT");
      return true;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  protected storedVersion(): number {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  }

  private tokenResult(operation: string, token: string): string | null {
    const row = this.db.prepare("SELECT result FROM client_tokens WHERE operation = ? AND token = ?").get(operation, token) as { result: string } | undefined;
    return row?.result ?? null;
  }

  private rows(sql: string, ...params: string[]): Record<string, unknown>[] {
    return (this.db.prepare(sql).all(...params) as { record: string }[]).map((row) => JSON.parse(row.record) as Record<string, unknown>);
  }
}
