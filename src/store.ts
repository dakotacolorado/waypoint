import { renameSync, rmSync } from "node:fs";
import { backup, DatabaseSync } from "node:sqlite";
import {
  DEFAULT_LIMIT,
  ForbiddenError,
  Graph,
  GraphError,
  MAX_LIMIT,
  MAX_TAGS,
  RECORDED,
  sameTags,
  STATUSES,
  WorkItem,
  ended,
  type Assignment,
  type ClosedReason,
  type Criterion,
  type Draft,
  type Filed,
  type HistoryEntry,
  type Note,
  type NoteKind,
  type Patch,
  type State,
  type Status,
  type Tick,
  type Type,
} from "./domain.ts";
import type { LastRun, QueueSettings } from "./queue.ts";
import { Tags, type Tag, type TagDraft, type TagPatch } from "./tags.ts";

const FULL_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

/** Every attempt at a write was decided against a read another write had already outdated. */
export class ConflictError extends Error {}

/** A start refused because the item's assignment is not the one the caller decided against: another start is ahead of it. */
export class AssignedError extends Error {
  readonly assignment: Assignment;

  constructor(message: string, assignment: Assignment) {
    super(message);
    this.assignment = assignment;
  }
}

/** What one write stores, removes and records, all or none. */
export interface Write {
  put: WorkItem[];
  remove?: string;
  /** Absent for a write to tags alone, which items' history does not record. */
  filed?: Filed[];
  putTags?: Tag[];
  removeTag?: string;
}

/** An item after a tag write, and how many items beneath it the write changed. */
export interface Retagged {
  item: WorkItem;
  reached: number;
}

/** A read of the whole set and every tag, and the version of both the read saw. */
export interface Snapshot {
  graph: Graph;
  tags: Tag[];
  version: number;
}

/**
 * Criteria, and their ticks, as a record holds them. One written before
 * criteria had ids is a list of texts, ticked by text: each gets the id of its
 * place, `c1` on, and each tick goes to the first criterion reading its text
 * that has none yet.
 */
function criteriaFromRecord(stored: unknown, ticks: unknown): { acceptanceCriteria: Criterion[]; met: Tick[] } {
  const given = (stored as (string | Criterion)[] | undefined) ?? [];
  const acceptanceCriteria = given.map((each, at) => (typeof each === "string" ? { id: `c${at + 1}`, text: each } : each));
  const met: Tick[] = [];
  for (const tick of (ticks as Tick[] | undefined) ?? []) {
    const by = acceptanceCriteria.find((each) => each.id === tick.criterion) ??
      acceptanceCriteria.find((each) => each.text === tick.criterion && !met.some((held) => held.criterion === each.id));
    if (by && !met.some((held) => held.criterion === by.id)) met.push({ ...tick, criterion: by.id });
  }
  return { acceptanceCriteria, met };
}

/**
 * `todo` was this status before it was named `ready`. A record written then is
 * read as `ready` rather than cast through unchecked, which would serve a value
 * the contract no longer has. Anything unrecognised falls back to `backlog`.
 */
function statusFromRecord(stored: unknown): Status {
  if (stored === "todo") return "ready";
  return STATUSES.includes(stored as Status) ? (stored as Status) : "backlog";
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, record TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tags (id TEXT PRIMARY KEY, record TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS history (seq INTEGER PRIMARY KEY AUTOINCREMENT, under TEXT NOT NULL, record TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS history_under ON history (under, seq);
CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, item TEXT NOT NULL, at TEXT NOT NULL, record TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS notes_item ON notes (item, at);
`;

/**
 * Items, tags, history and notes in one SQLite database. Each record is its
 * JSON, read field by field with a fallback, so a field added later needs no
 * migration. History keeps one copy of each entry per item it is filed under,
 * so reading an item's history is one indexed read.
 *
 * Every write validates against the whole set, so every write reads it first,
 * and commits only if no other write has landed since; otherwise it is decided
 * again against a fresh read.
 */
export class WorkItemStore {
  static readonly ATTEMPTS = 5;

  readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    db.exec(SCHEMA);
  }

  /** The database at `path`, made if absent; `:memory:` for one that lasts as long as the process. */
  static open(path: string): WorkItemStore {
    return new WorkItemStore(new DatabaseSync(path));
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

  async graph(): Promise<Graph> {
    return (await this.snapshot()).graph;
  }

  /** Not a snapshot: read on its own, without the items. */
  async tags(): Promise<Tags> {
    return new Tags(this.rows("SELECT record FROM tags").map(WorkItemStore.tagFromRecord));
  }

  async createTag(draft: TagDraft): Promise<Tag> {
    return this.decide((_graph, tags) => {
      const tag = tags.create(draft);
      return { result: tag, write: { put: [], putTags: [tag] } };
    });
  }

  /** Null when no tag has that id. */
  async updateTag(id: string, patch: TagPatch): Promise<Tag | null> {
    return this.decide((_graph, tags) => {
      const current = tags.get(id);
      if (!current) return { result: null };
      const next = tags.patched(current, patch);
      return { result: next, write: { put: [], putTags: [next] } };
    });
  }

  /** Throws GraphError while any item, open or closed, carries the tag. */
  async removeTag(id: string): Promise<void> {
    await this.decide((graph, tags) => {
      if (!tags.get(id)) return { result: undefined };
      const carrying = graph.carrying(id);
      if (carrying.length) {
        const named = carrying.slice(0, 5).map((each) => graph.shortId(each));
        const more = carrying.length > named.length ? ", …" : "";
        throw new GraphError(
          `still referenced by ${carrying.length} item(s) carrying it: ${named.join(", ")}${more}; take it off them first`,
        );
      }
      return { result: undefined, write: { put: [], removeTag: id } };
    });
  }

  /**
   * Adds the tag `ref` names, by id or value, to the item and every item beneath
   * it, open or closed; null when no item has that id. `reached` counts the
   * items beneath it that changed.
   */
  async tagItem(id: string, ref: string, claimedBy: string | null = null): Promise<Retagged | null> {
    return this.decide((graph, tags) => {
      const current = graph.get(graph.resolve(id));
      if (!current) return { result: null };
      const tag = tags.find(ref);
      if (!tag) throw new GraphError(`no tag with id or value "${ref}"`);
      return this.retagged(graph, current, (carried) => (carried.includes(tag.id) ? carried : [...carried, tag.id]), claimedBy);
    });
  }

  /** Takes the tag `ref` names, by id or value, off the item and every item beneath it; as `tagItem`. */
  async untagItem(id: string, ref: string, claimedBy: string | null = null): Promise<Retagged | null> {
    return this.decide((graph, tags) => {
      const current = graph.get(graph.resolve(id));
      if (!current) return { result: null };
      const tag = tags.find(ref)?.id ?? ref;
      return this.retagged(graph, current, (carried) => carried.filter((each) => each !== tag), claimedBy);
    });
  }

  private retagged(graph: Graph, current: WorkItem, retag: (tags: string[]) => string[], claimedBy: string | null) {
    const now = new Date().toISOString();
    const own = retag(current.tags);
    const next = sameTags(own, current.tags) ? current : current.tagged(own, now);
    const beneath = graph.retaggedBeneath(current.id, retag, now);
    const put = [...(next === current ? [] : [next]), ...beneath];
    if (!put.length) return { result: { item: current, reached: 0 } };
    WorkItemStore.checkTagLimit(graph, put);
    const filed = [
      ...(next === current ? [] : [graph.filed("updated", current, next, now, claimedBy)]),
      ...beneath.map((item) => WorkItemStore.filedBeneath(graph, item, next, claimedBy)),
    ];
    return { result: { item: next, reached: beneath.length }, write: { put, filed } };
  }

  /**
   * `next`, and the items beneath it, carrying the tags of the parent it moves
   * under besides their own; moving away takes none off.
   */
  private static joined(graph: Graph, current: WorkItem, next: WorkItem): { item: WorkItem; retagged: WorkItem[] } {
    const parentTags = next.parent === null || next.parent === current.parent ? [] : (graph.get(next.parent)?.tags ?? []);
    if (!parentTags.length) return { item: next, retagged: [] };
    const join = (carried: string[]) => [...carried, ...parentTags.filter((tag) => !carried.includes(tag))];
    const own = join(next.tags);
    return {
      item: sameTags(own, next.tags) ? next : next.tagged(own, next.updatedAt),
      retagged: graph.retaggedBeneath(current.id, join, next.updatedAt),
    };
  }

  /**
   * An item changed beneath `top`, the one a write names, filed under it and
   * every item above it as the write leaves them: up to `top`, then above `top`
   * where it now sits, which a move changes for everything beneath it.
   */
  private static filedBeneath(graph: Graph, after: WorkItem, top: WorkItem, claimedBy: string | null): Filed {
    const filed = graph.filed("updated", graph.get(after.id)!, after, after.updatedAt, claimedBy);
    const between: string[] = [];
    for (let at = after.parent; at !== null && at !== top.id && !between.includes(at); at = graph.get(at)?.parent ?? null) {
      between.push(at);
    }
    const above = graph.ancestorsOf(top.parent).map((item) => item.id);
    return { ...filed, under: [...new Set([after.id, ...between, top.id, ...above])] };
  }

  private static checkTagLimit(graph: Graph, items: WorkItem[]): void {
    const over = items.filter((item) => item.tags.length > MAX_TAGS).map((item) => graph.shortId(item.id));
    if (over.length) {
      throw new GraphError(`an item carries at most ${MAX_TAGS} tags, and this would give more to ${over.join(", ")}: take one off first`);
    }
  }

  /** Ticks one criterion, by its text, leaving the others as the write finds them; null when no item has that id. */
  async tick(id: string, criterion: string, claimedBy: string | null = null): Promise<WorkItem | null> {
    return this.rewritten(id, claimedBy, (current, now) => current.ticked(criterion, claimedBy, now));
  }

  /** Unticks one criterion, by its text; as `tick`. */
  async untick(id: string, criterion: string, claimedBy: string | null = null): Promise<WorkItem | null> {
    return this.rewritten(id, claimedBy, (current, now) => current.unticked(criterion, now));
  }

  /** The item `change` gives, written with its history entry unless it is the item unchanged. */
  private async rewritten(
    id: string,
    claimedBy: string | null,
    change: (current: WorkItem, now: string) => WorkItem,
  ): Promise<WorkItem | null> {
    return this.decide((graph) => {
      const current = graph.get(graph.resolve(id));
      if (!current) return { result: null };
      const now = new Date().toISOString();
      const next = change(current, now);
      if (next === current) return { result: current };
      return { result: next, write: { put: [next], filed: [graph.filed("updated", current, next, now, claimedBy)] } };
    });
  }

  async create(draft: Draft, claimedBy: string | null = null): Promise<WorkItem> {
    return this.decide((graph) => {
      const made = WorkItem.create(graph.resolveRefs(draft), claimedBy, undefined, graph.freshId());
      const parentTags = made.parent === null ? [] : (graph.get(made.parent)?.tags ?? []);
      const item = parentTags.length ? made.tagged(parentTags, made.createdAt) : made;
      graph.validate(item);
      graph.checkStart(null, item);
      const filed = graph.filed("created", null, item, item.createdAt, claimedBy);
      return { result: item, write: { put: [item], filed: [filed] } };
    });
  }

  async update(
    id: string,
    patch: Patch,
    claimedBy: string | null = null,
  ): Promise<WorkItem | null> {
    return this.decide((graph) => {
      const current = graph.get(graph.resolve(id));
      if (!current) return { result: null };
      const next = current.patched(graph.resolveRefs(patch), claimedBy);
      graph.validate(next, current);
      const overrode = graph.overriding(current, next, patch.force === true, claimedBy, patch.status !== undefined);
      graph.checkSignOff(current, next, claimedBy);
      graph.checkQueue(next, patch.queued);
      const closed = graph.closedBeneath(current, next);
      const { item, retagged } = WorkItemStore.joined(graph, current, next);
      const beneath = new Map(closed.map((each) => [each.id, each]));
      for (const each of retagged) beneath.set(each.id, beneath.get(each.id)?.tagged(each.tags, each.updatedAt) ?? each);
      const put = [item, ...beneath.values()];
      WorkItemStore.checkTagLimit(graph, put);
      const filed = [
        graph.filed("updated", current, item, item.updatedAt, claimedBy, overrode),
        ...retagged.map((each) => WorkItemStore.filedBeneath(graph, beneath.get(each.id)!, item, claimedBy)),
      ];
      return { result: item, write: { put, filed } };
    });
  }

  /**
   * Gives the item `assignment` if its assignment is still the one with id
   * `replacing`, as the caller found it; throws AssignedError naming the one
   * there otherwise. See `Graph.assigned`. Null when no item has that id.
   */
  async assign(
    id: string,
    assignment: Assignment,
    replacing: string | null,
  ): Promise<{ item: WorkItem; before: WorkItem[] } | null> {
    return this.decide((graph) => {
      const current = graph.get(graph.resolve(id));
      if (!current) return { result: null };
      if (current.state === "closed") throw new GraphError("a closed item cannot be started: reopen it first");
      const there = current.assignment;
      if ((there?.id ?? null) !== replacing) {
        throw new AssignedError(`${graph.shortId(current.id)} was just started on ${there!.name}`, there!);
      }
      const { put, before } = graph.assigned(current, assignment, assignment.at);
      const [item, ...beneath] = put;
      const filed = [
        graph.filed("updated", current, item!, assignment.at, assignment.by),
        ...beneath.map((each) => WorkItemStore.filedBeneath(graph, each, item!, assignment.by)),
      ];
      return { result: { item: item!, before }, write: { put, filed } };
    });
  }

  /** Undoes `assign`, given what it returned as `before`, unless another assignment has replaced it. */
  async unassign(before: WorkItem[], assignment: Assignment): Promise<void> {
    await this.decide((graph) => {
      const put = graph.unassigned(before, assignment, new Date().toISOString());
      if (!put.length) return { result: undefined };
      const [item, ...beneath] = put;
      const filed = [
        graph.filed("updated", graph.get(item!.id)!, item!, item!.updatedAt, assignment.by),
        ...beneath.map((each) => WorkItemStore.filedBeneath(graph, each, item!, assignment.by)),
      ];
      return { result: undefined, write: { put, filed } };
    });
  }

  /**
   * Ends the item's assignment `assignment` for `why`, unless it has ended or
   * another has replaced it, and the item is no longer held by its agent; its
   * status stays. The item as it then stands; null when no item has that id.
   */
  async endAssignment(id: string, assignment: string, why: string, claimedBy: string | null): Promise<WorkItem | null> {
    return this.decide((graph) => {
      const current = graph.get(id);
      if (!current) return { result: null };
      const there = current.assignment;
      if (there?.id !== assignment || there.ended) return { result: current };
      const now = new Date().toISOString();
      const next = new WorkItem({
        ...current.toJSON(),
        assignment: ended(there, now, why),
        heldBy: current.heldBy === there.name ? null : current.heldBy,
        updatedAt: now,
      });
      return { result: next, write: { put: [next], filed: [graph.filed("updated", current, next, now, claimedBy)] } };
    });
  }

  /**
   * Writes the agent's id, and its name if given, to the item's assignment
   * `assignment`, the item held by that name if it was held by the one before;
   * the item as it then stands, or null once another has replaced it.
   */
  async recordAgent(id: string, assignment: string, agent: string, name?: string): Promise<WorkItem | null> {
    return this.decide((graph) => {
      const current = graph.get(id);
      if (!current || current.assignment?.id !== assignment) return { result: null };
      const there = current.assignment;
      const named = name ?? there.name;
      if (there.agent === agent && there.name === named) return { result: current };
      const next = new WorkItem({
        ...current.toJSON(),
        assignment: { ...there, agent, name: named },
        ...(current.heldBy === there.name && { heldBy: named }),
        updatedAt: new Date().toISOString(),
      });
      const filed = graph.filed("updated", current, next, next.updatedAt, current.assignment.by);
      return { result: next, write: { put: [next], filed: [filed] } };
    });
  }

  /** Throws GraphError while another item names this one. */
  async remove(id: string, claimedBy: string | null = null): Promise<void> {
    await this.decide((graph) => {
      const current = graph.get(graph.resolve(id));
      if (!current) return { result: undefined };
      const { id: removed } = current;
      const referenced = graph.referencesTo(removed);
      if (referenced.length) {
        throw new GraphError(`still referenced by ${referenced.length} item(s)`);
      }
      const now = new Date().toISOString();
      const filed = graph.filed("deleted", current, null, now, claimedBy);
      return { result: undefined, write: { put: [], remove: removed, filed: [filed] } };
    });
  }

  /** See `Graph.resolve`. A full id is taken as given, without reading the set, so a deleted item's still reads its history and notes. */
  async resolve(ref: string): Promise<string> {
    return FULL_ID.test(ref) ? ref : (await this.graph()).resolve(ref);
  }

  /** Oldest first. Null when the item does not exist and never did. */
  async history(id: string): Promise<HistoryEntry[] | null> {
    const entries = await this.filedUnder(id);
    if (entries.length) return entries;
    return (await this.graph()).get(id) ? [] : null;
  }

  /**
   * Stores a comment or work-log entry on an item. Outside the set and its
   * version, so it neither waits on nor holds up a write to any item. Null
   * when the item does not exist.
   */
  async addNote(note: Note): Promise<Note | null> {
    if (!(await this.exists(note.item))) return null;
    await this.putNote(note);
    return note;
  }

  /** Oldest first. Null when the item does not exist and has none; a deleted item's are kept. */
  async notes(id: string, kind: NoteKind): Promise<Note[] | null> {
    const notes = await this.notesUnder(id);
    if (!notes.length && !(await this.exists(id))) return null;
    return notes.filter((note) => note.kind === kind);
  }

  async queueSettings(): Promise<QueueSettings> {
    const record = await this.queueRecord();
    const limit = record?.limit;
    return {
      limit: Number.isInteger(limit) && (limit as number) >= 1 && (limit as number) <= MAX_LIMIT ? (limit as number) : DEFAULT_LIMIT,
      last: (record?.last as LastRun | undefined) ?? null,
    };
  }

  /** Throws ForbiddenError for a write that says who it is from: only the person sets it. */
  async setQueueLimit(limit: number, claimedBy: string | null): Promise<void> {
    if (claimedBy !== null) throw new ForbiddenError(`only the person sets the queue's running limit, not ${claimedBy}`);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new GraphError(`the running limit is from 1 to ${MAX_LIMIT}, not ${limit}`);
    await this.putQueueField("limit", limit);
  }

  async recordQueueRun(last: LastRun): Promise<void> {
    await this.putQueueField("last", last);
  }

  /** Runs `decision` against fresh reads until one commits; throws ConflictError if none does. */
  private async decide<T>(
    decision: (graph: Graph, tags: Tags) => { result: T; write?: Write },
  ): Promise<T> {
    for (let attempt = 0; attempt < WorkItemStore.ATTEMPTS; attempt++) {
      const { graph, tags, version } = await this.snapshot();
      const { result, write } = decision(graph, new Tags(tags));
      if (!write) return result;
      if (await this.commit(version, write)) return result;
    }
    throw new ConflictError("other writes kept landing first; retry");
  }

  // `snapshot`, `commit`, `tags`, `filedUnder`, `exists`, `putNote`, `notesUnder`, `queueRecord` and `putQueueField` are the only persistence;
  // everything above is logic, so a test double can replace these and exercise the rest.

  protected async snapshot(): Promise<Snapshot> {
    const version = this.storedVersion();
    const items = this.rows("SELECT record FROM items").map(WorkItemStore.itemFromRecord);
    const tags = this.rows("SELECT record FROM tags").map(WorkItemStore.tagFromRecord);
    return { graph: new Graph(items), tags, version };
  }

  /** All or none, and only if the set is still at `version`; false when it is not. */
  protected async commit(version: number, write: Write): Promise<boolean> {
    const { put, remove, filed, putTags = [], removeTag } = write;
    return this.transaction(() => {
      if (this.storedVersion() !== version) return false;
      this.db.prepare("INSERT INTO meta (key, value) VALUES ('version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(JSON.stringify(version + 1));
      const putItem = this.db.prepare("INSERT INTO items (id, record) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET record = excluded.record");
      for (const item of put) putItem.run(item.id, JSON.stringify(item.toJSON()));
      const putTag = this.db.prepare("INSERT INTO tags (id, record) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET record = excluded.record");
      for (const tag of putTags) putTag.run(tag.id, JSON.stringify(tag));
      if (remove !== undefined) this.db.prepare("DELETE FROM items WHERE id = ?").run(remove);
      if (removeTag !== undefined) this.db.prepare("DELETE FROM tags WHERE id = ?").run(removeTag);
      const file = this.db.prepare("INSERT INTO history (under, record) VALUES (?, ?)");
      for (const { entry, under } of filed ?? []) {
        const record = JSON.stringify(entry);
        for (const each of under) file.run(each, record);
      }
      return true;
    });
  }

  protected async filedUnder(id: string): Promise<HistoryEntry[]> {
    return this.rows("SELECT record FROM history WHERE under = ? ORDER BY seq", id).map(WorkItemStore.historyFromRecord);
  }

  protected async exists(id: string): Promise<boolean> {
    return this.db.prepare("SELECT 1 FROM items WHERE id = ?").get(id) !== undefined;
  }

  protected async putNote(note: Note): Promise<void> {
    this.db.prepare("INSERT INTO notes (id, item, at, record) VALUES (?, ?, ?, ?)").run(note.id, note.item, note.at, JSON.stringify(note));
  }

  /** Oldest first, a tie in time in the order stored. */
  protected async notesUnder(id: string): Promise<Note[]> {
    return this.rows("SELECT record FROM notes WHERE item = ? ORDER BY at, rowid", id).map(WorkItemStore.noteFromRecord);
  }

  protected async queueRecord(): Promise<Record<string, unknown> | null> {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'queue'").get() as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as Record<string, unknown>) : null;
  }

  /** One field alone, so the person's limit and the dispatcher's run never write over each other. */
  protected async putQueueField(field: "limit" | "last", value: unknown): Promise<void> {
    this.transaction(() => {
      const row = this.db.prepare("SELECT value FROM meta WHERE key = 'queue'").get() as { value: string } | undefined;
      const record = { ...(row ? (JSON.parse(row.value) as Record<string, unknown>) : {}), [field]: value };
      this.db.prepare("INSERT INTO meta (key, value) VALUES ('queue', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(JSON.stringify(record));
    });
  }

  /** The set's version: how many writes to items or tags have committed. */
  protected storedVersion(): number {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as number) : 0;
  }

  private rows(sql: string, ...params: string[]): Record<string, unknown>[] {
    return (this.db.prepare(sql).all(...params) as { record: string }[]).map((row) => JSON.parse(row.record) as Record<string, unknown>);
  }

  /** `run` inside one write transaction, rolled back if it throws. */
  protected transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  static tagFromRecord(record: Record<string, unknown>): Tag {
    return {
      id: record.id as string,
      value: record.value as string,
      color: (record.color as string) ?? "#808080",
      description: (record.description as string) ?? "",
      createdAt: record.createdAt as string,
      updatedAt: (record.updatedAt as string) ?? (record.createdAt as string),
    };
  }

  static historyFromRecord(record: Record<string, unknown>): HistoryEntry {
    return {
      item: record.item as string,
      action: record.action as HistoryEntry["action"],
      // Entries can carry fields since dropped, such as `doneAsLeaf` and `closedWith`.
      changes: (record.changes as HistoryEntry["changes"]).filter((change) =>
        RECORDED.includes(change.field),
      ),
      at: record.at as string,
      claimedBy: (record.claimedBy as string | null) ?? null,
      overrode: (record.overrode as string[] | undefined) ?? [],
    };
  }

  static noteFromRecord(record: Record<string, unknown>): Note {
    return {
      id: record.id as string,
      item: record.item as string,
      kind: (record.kind as NoteKind) ?? "comment",
      author: (record.author as string | null) ?? null,
      at: record.at as string,
      body: record.body as string,
      links: (record.links as string[]) ?? [],
    };
  }

  /**
   * An absent field means a record stored before that field existed, so each
   * one falls back rather than reading as undefined. A field since removed,
   * such as `rank`, is simply not read, which is how it leaves the model.
   */
  static itemFromRecord(record: Record<string, unknown>): WorkItem {
    const status = statusFromRecord(record.status);
    const state = (record.state as State) ?? "open";
    return new WorkItem({
      id: record.id as string,
      type: (record.type as Type) ?? "task",
      title: record.title as string,
      body: (record.body as string) ?? "",
      ...criteriaFromRecord(record.acceptanceCriteria, record.met),
      status,
      state,
      closedReason: (record.closedReason as ClosedReason | null) ?? null,
      parent: (record.parent as string | null) ?? null,
      dependsOn: (record.dependsOn as string[]) ?? [],
      createdAt: record.createdAt as string,
      updatedAt: record.updatedAt as string,
      heldBy: (record.heldBy as string | null) ?? null,
      reviewedBy: (record.reviewedBy as string | null) ?? null,
      queuedAt: (record.queuedAt as string | null) ?? null,
      tags: (record.tags as string[]) ?? [],
      assignment: record.assignment ? { ...(record.assignment as Assignment), ended: (record.assignment as Assignment).ended ?? null } : null,
    });
  }
}
