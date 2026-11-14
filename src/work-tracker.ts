import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Tasks, type Criterion, type HistoryEntry, type Status, type Subtask, type Task } from "./domain.ts";
import type { Label } from "./labels.ts";
import type { Comment } from "./store.ts";

/**
 * A one-way copy of work-tracker-service's items into waypoint, keeping their
 * ids, timestamps and authors, so it writes the database directly rather than
 * through the API, which draws its own. Each old epic is a task with its id,
 * each of its stories a subtask of it, a story's old tasks a list in that
 * subtask's description. Run again, it adds only what is new and updates only
 * what it wrote and nobody has changed since.
 */

// --- work-tracker-service, as its API gives it -----------------------------

export interface OldItem {
  id: string;
  shortId: string;
  type: "epic" | "story" | "task";
  title: string;
  body: string;
  acceptanceCriteria: string[];
  met: { criterion: string; by: string | null; at: string }[];
  status: "backlog" | "ready" | "in_progress" | "review" | "done";
  state: "open" | "closed";
  closedReason: "completed" | "not_planned" | null;
  parent: string | null;
  dependsOn: string[];
  createdAt: string;
  updatedAt: string;
  /** When it was closed, where the tracker gives it; else read from its history. */
  closedAt?: string | null;
  heldBy: string | null;
  tags: string[];
}

export interface OldTag {
  id: string;
  value: string;
  color: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface OldHistoryEntry {
  item: string;
  action: "created" | "updated" | "deleted";
  changes: { field: string; from: unknown; to: unknown }[];
  at: string;
  claimedBy: string | null;
  overrode?: string[];
}

export interface OldComment {
  id: string;
  item: string;
  author: string | null;
  at: string;
  body: string;
  links?: string[];
}

/** Everything the import reads: each item with what is filed under it. */
export interface Source {
  items: OldItem[];
  tags: OldTag[];
  /** By item id: its history (entries for items beneath it among them), comments and work log. */
  detail: Record<string, { history: OldHistoryEntry[]; comments: OldComment[]; workLog: OldComment[] }>;
}

/** Reads every item, open and closed, and what is filed under each, by GET requests alone. */
export async function readWorkTracker(url: string, token: string, fetcher: typeof fetch = fetch, concurrency = 8): Promise<Source> {
  const base = url.replace(/\/+$/, "");
  const get = async <T>(path: string): Promise<T> => {
    const res = await fetcher(`${base}${path}`, { method: "GET", headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  };
  const { items } = await get<{ items: OldItem[] }>("/items");
  const { tags } = await get<{ tags: OldTag[] }>("/tags");
  const detail: Source["detail"] = {};
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const { id } = items[next++]!;
      const [history, comments, workLog] = await Promise.all([
        get<{ entries: OldHistoryEntry[] }>(`/items/${id}/history`),
        get<{ comments: OldComment[] }>(`/items/${id}/comments`),
        get<{ entries: OldComment[] }>(`/items/${id}/work-log`),
      ]);
      detail[id] = { history: history.entries, comments: comments.comments, workLog: workLog.entries };
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { items, tags, detail };
}

// --- the mapping -----------------------------------------------------------

/** `closed` as `completed` is `done`, as `not_planned` `cancelled`; an open `ready` is `backlog`. */
export function statusOf(item: Pick<OldItem, "status" | "state" | "closedReason">): Status {
  if (item.state === "closed") return item.closedReason === "not_planned" ? "cancelled" : "done";
  return item.status === "ready" ? "backlog" : item.status;
}

/** A UUID drawn from `seed`, so a second run makes the same one. */
export function seededId(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The id of the `epic:<shortId>` label an import before 0.6.0 made for an old epic, which `--remove` deletes. */
export const epicLabelId = (epicId: string) => seededId(`work-tracker epic label ${epicId}`);

const historyKey = (entry: OldHistoryEntry) => createHash("sha256").update(JSON.stringify([entry.item, entry.at, entry.action, entry.changes])).digest("hex");

/** Who ticks, at import, a criterion left unmet on an item imported as `done`. */
export const IMPORT_ACTOR = "import";

/** When `item` was closed: its `closedAt`, else its last own history entry closing it, else its `updatedAt`. */
function closedAtOf(item: OldItem, history: OldHistoryEntry[]): string {
  if (item.closedAt) return item.closedAt;
  const closing = history.filter((entry) => entry.item === item.id && entry.changes.some((change) => change.field === "state" && change.to === "closed"));
  return closing.map((entry) => entry.at).sort().at(-1) ?? item.updatedAt;
}

/**
 * Its criteria with their ticks. An item imported as `done` has every one met,
 * those left unmet ticked by the import at its close, as the person decided:
 * waypoint refuses any update to a `done` task with a criterion unmet.
 */
const criteriaOf = (item: OldItem, history: OldHistoryEntry[]): Criterion[] => {
  const closedAt = statusOf(item) === "done" ? closedAtOf(item, history) : null;
  return item.acceptanceCriteria.map((text, i) => {
    const tick = item.met.find((each) => each.criterion === text);
    if (tick) return { id: `c${i + 1}`, text, met: true, metBy: tick.by ?? null, metAt: tick.at };
    if (closedAt) return { id: `c${i + 1}`, text, met: true, metBy: IMPORT_ACTOR, metAt: closedAt };
    return { id: `c${i + 1}`, text, met: false, metBy: null, metAt: null };
  });
};

const tickedAtImport = (item: OldItem, criteria: Criterion[]) =>
  criteria.some((criterion) => criterion.metBy === IMPORT_ACTOR && !item.met.some((tick) => tick.criterion === criterion.text));

/** The API's limit on a description. */
const MAX_DESCRIPTION = 20_000;
const TASK_BODY_SHOWN = 300;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const describe = (body: string, extra: string[]) => clip([body, extra.join("\n")].filter(Boolean).join("\n\n---\n"), MAX_DESCRIPTION);

/** An old story's tasks as a checklist, each with the start of its body indented beneath. */
const taskList = (tasks: OldItem[]): string[] => [
  "Tasks:",
  ...tasks.flatMap((task) => {
    const status = statusOf(task);
    const body = task.body.trim() ? clip(task.body.trim(), TASK_BODY_SHOWN).split("\n").map((line) => `  ${line}`.trimEnd()) : [];
    return [`- [${status === "done" ? "x" : " "}] ${task.title} (task \`${task.shortId}\`${status === "done" ? "" : `, ${status}`})`, ...body];
  }),
];

/** An old story as a subtask's description: its body, criteria, old ids, what it depends on outside its epic, and its tasks. */
function storyDescription(story: OldItem, criteria: Criterion[], tasks: OldItem[], outside: OldItem[], missing: string[]): string {
  const lines: string[] = [];
  if (criteria.length) lines.push("Acceptance criteria:", ...criteria.map((each) => `- [${each.met ? "x" : " "}] ${each.text}`), "");
  lines.push(`Was story \`${story.shortId}\` (\`${story.id}\`).`);
  if (outside.length || missing.length) {
    lines.push("", `Depends on, outside this epic: ${[...outside.map((dep) => `\`${dep.shortId}\` (${dep.type})`), ...missing.map((id) => `\`${id}\``)].join(", ")}.`);
  }
  if (tasks.length) lines.push("", ...taskList(tasks));
  return describe(story.body, lines);
}

const withLinks = (entry: OldComment) => (entry.links?.length ? `${entry.body}\n\nLinks:\n${entry.links.map((link) => `- ${link}`).join("\n")}` : entry.body);

// --- the import ------------------------------------------------------------

const SCHEMA = `CREATE TABLE IF NOT EXISTS work_tracker_import (kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (kind, key));`;

export interface Report {
  dryRun: boolean;
  source: { items: Record<string, number>; tags: number; comments: number; workLog: number; history: number };
  tasks: { created: number; updated: number; unchanged: number };
  subtasks: number;
  labels: { created: number; updated: number; unchanged: number };
  added: { comments: number; history: number };
  /** Tasks and labels with an old id that waypoint made itself, or that were changed in waypoint since the import wrote them: left alone. */
  leftAlone: { id: string; why: string }[];
  /** Old short ids that don't name the same item in waypoint. */
  clashes: { shortId: string; item: string; why: string }[];
  /** Old tags whose name a label made in waypoint already has: that label is used. */
  labelsShared: { tag: string; label: string }[];
  /** Imported as `done` with criteria the old tracker left unmet: the import ticked them, as met at its close. */
  criteriaTickedAtImport: string[];
  /** Imported as `done` with criteria unmet, which waypoint refuses any update to until they are met or it moves: none, since the import ticks them. */
  doneWithUnmetCriteria: string[];
  /** Imported as `done` with a subtask still open, which waypoint refuses any update to until it closes or the task moves. */
  doneWithOpenSubtasks: string[];
  /** Stories with no epic and old tasks with no story: each a task of its own. */
  ownTasks: { stories: string[]; tasks: string[] };
  /** Stories and old tasks an earlier import made tasks of, still there: `--remove` deletes them. */
  stale: string[];
}

/** The store refuses to commit a write decided before this one, and decides it again. */
function bumpVersion(db: DatabaseSync): void {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value: string } | undefined;
  db.prepare("INSERT INTO meta (key, value) VALUES ('version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(String(Number(row?.value ?? 0) + 1));
}

/** Runs `write` in one transaction, rolled back on a dry run; bumps the version if it wrote. */
function transaction<T>(db: DatabaseSync, dryRun: boolean, write: () => { result: T; wrote: number }): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const { result, wrote } = write();
    if (dryRun) db.exec("ROLLBACK");
    else {
      if (wrote) bumpVersion(db);
      db.exec("COMMIT");
    }
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** How the old items nest: an epic's stories and a story's tasks, each in creation order, and those that stand alone. */
function shape(items: OldItem[]) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const parentOf = (item: OldItem) => {
    const parent = item.parent ? byId.get(item.parent) : undefined;
    return (item.type === "story" && parent?.type === "epic") || (item.type === "task" && parent?.type === "story") ? parent.id : null;
  };
  const childrenOf = new Map<string, OldItem[]>();
  for (const item of [...items].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const parent = parentOf(item);
    if (parent) childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), item]);
  }
  return { byId, parentOf, children: (id: string) => childrenOf.get(id) ?? [], top: items.filter((item) => item.type === "epic" || !parentOf(item)) };
}

/**
 * Copies `source` into the store's database in one transaction. Safe while
 * the server runs on it: the version it bumps makes any write decided before
 * it decide again. With `dryRun`, reports what it would do and writes nothing.
 */
export function importWorkTracker(db: DatabaseSync, source: Source, { dryRun = false } = {}): Report {
  db.exec(SCHEMA);
  const { byId, parentOf, children, top } = shape(source.items);
  const topIds = new Set(top.map((item) => item.id));
  const detail = (id: string) => source.detail[id] ?? { history: [], comments: [], workLog: [] };
  const report: Report = {
    dryRun,
    source: { items: {}, tags: source.tags.length, comments: 0, workLog: 0, history: 0 },
    tasks: { created: 0, updated: 0, unchanged: 0 },
    subtasks: 0,
    labels: { created: 0, updated: 0, unchanged: 0 },
    added: { comments: 0, history: 0 },
    leftAlone: [],
    clashes: [],
    labelsShared: [],
    criteriaTickedAtImport: [],
    doneWithUnmetCriteria: [],
    doneWithOpenSubtasks: [],
    ownTasks: {
      stories: top.filter((item) => item.type === "story").map((item) => item.shortId),
      tasks: top.filter((item) => item.type === "task").map((item) => item.shortId),
    },
    stale: [],
  };
  for (const item of source.items) {
    const key = `${item.type} ${statusOf(item)}`;
    report.source.items[key] = (report.source.items[key] ?? 0) + 1;
    const own = detail(item.id);
    report.source.comments += own.comments.length;
    report.source.workLog += own.workLog.length;
    report.source.history += own.history.filter((entry) => entry.item === item.id).length;
  }

  const tracked = (kind: string, key: string) => (db.prepare("SELECT value FROM work_tracker_import WHERE kind = ? AND key = ?").get(kind, key) as { value: string } | undefined)?.value;
  const track = (kind: string, key: string, value: string) =>
    db.prepare("INSERT INTO work_tracker_import (kind, key, value) VALUES (?, ?, ?) ON CONFLICT (kind, key) DO UPDATE SET value = excluded.value").run(kind, key, value);
  const stored = (table: "tasks" | "labels", id: string) => (db.prepare(`SELECT record FROM ${table} WHERE id = ?`).get(id) as { record: string } | undefined)?.record;

  /** Writes `record` unless waypoint made it or changed it since; whether it is the import's to fill. */
  const native = new Set<string>();
  const upsert = (table: "tasks" | "labels", kind: "task" | "label", record: Task | Label, count: Report["tasks"]): boolean => {
    const json = JSON.stringify(record);
    const current = stored(table, record.id);
    const wrote = tracked(kind, record.id);
    if (current !== undefined && wrote === undefined) {
      report.leftAlone.push({ id: record.id, why: `a ${kind} waypoint made itself has this id` });
      native.add(record.id);
      return false;
    }
    if (current !== undefined && current !== wrote) {
      report.leftAlone.push({ id: record.id, why: `the ${kind} was changed in waypoint since the import wrote it` });
      return true;
    }
    if (current === json) {
      count.unchanged++;
      return true;
    }
    db.prepare(`INSERT INTO ${table} (id, record) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET record = excluded.record`).run(record.id, json);
    track(kind, record.id, json);
    count[current === undefined ? "created" : "updated"]++;
    return true;
  };

  return transaction(db, dryRun, () => {
    // Labels: one per tag.
    const nativeByName = new Map(
      (db.prepare("SELECT id, record FROM labels").all() as { id: string; record: string }[])
        .filter((row) => tracked("label", row.id) === undefined)
        .map((row) => [(JSON.parse(row.record) as Label).name.toLowerCase(), row.id]),
    );
    const labelId = new Map<string, string>();
    for (const tag of source.tags) {
      const shared = nativeByName.get(tag.value.toLowerCase());
      if (shared && shared !== tag.id) {
        report.labelsShared.push({ tag: tag.value, label: shared });
        labelId.set(tag.id, shared);
        continue;
      }
      upsert("labels", "label", { id: tag.id, name: tag.value, color: tag.color, description: tag.description, createdAt: tag.createdAt, updatedAt: tag.updatedAt }, report.labels);
      labelId.set(tag.id, tag.id);
    }

    // Each epic's stories are its subtasks, numbered in creation order and kept across runs.
    const subtaskIds = new Map<string, string>();
    for (const epic of top.filter((item) => item.type === "epic")) {
      const stories = children(epic.id);
      const was = (story: OldItem) => tracked("subtask", story.id)?.match(new RegExp(`^${epic.id}/(s\\d+)$`))?.[1];
      let next = Math.max(0, ...stories.map((story) => Number(was(story)?.slice(1) ?? 0)));
      for (const story of stories) subtaskIds.set(story.id, was(story) ?? `s${++next}`);
    }

    // Tasks: every epic, and every story or old task with nothing above it.
    for (const item of top) {
      const stories = item.type === "epic" ? children(item.id) : [];
      const ticked: string[] = [];
      const subtasks: Subtask[] = stories.map((story) => {
        const deps = story.dependsOn.map((id) => byId.get(id));
        const siblings = deps.filter((dep): dep is OldItem => dep !== undefined && dep.id !== story.id && subtaskIds.has(dep.id) && parentOf(dep) === item.id);
        const outside = deps.filter((dep): dep is OldItem => dep !== undefined && !siblings.includes(dep));
        const criteria = criteriaOf(story, detail(story.id).history);
        if (tickedAtImport(story, criteria)) ticked.push(story.shortId);
        return {
          id: subtaskIds.get(story.id)!,
          title: story.title,
          description: storyDescription(story, criteria, children(story.id), outside, story.dependsOn.filter((id) => !byId.has(id))),
          status: statusOf(story),
          dependsOn: siblings.map((dep) => subtaskIds.get(dep.id)!),
        };
      });
      const ownTasks = item.type === "story" ? children(item.id) : [];
      const tags = [...item.tags, ...stories.flatMap((story) => story.tags)];
      const task: Task = {
        id: item.id,
        title: item.title,
        description: ownTasks.length ? describe(item.body, taskList(ownTasks)) : item.body,
        status: statusOf(item),
        dependsOn: item.dependsOn.filter((id) => topIds.has(id) && id !== item.id),
        subtasks,
        criteria: criteriaOf(item, detail(item.id).history),
        labels: [...new Set(tags.map((tag) => labelId.get(tag) ?? tag))],
        assignee: item.state === "open" ? item.heldBy : null,
        verification: null,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      };
      if (!upsert("tasks", "task", task, report.tasks)) continue;
      report.subtasks += subtasks.length;
      for (const story of stories) track("subtask", story.id, `${item.id}/${subtaskIds.get(story.id)}`);
      if (tickedAtImport(item, task.criteria)) report.criteriaTickedAtImport.push(item.shortId);
      report.criteriaTickedAtImport.push(...ticked);
      if (task.status === "done" && task.criteria.some((criterion) => !criterion.met)) report.doneWithUnmetCriteria.push(item.shortId);
      if (task.status === "done" && subtasks.some((sub) => sub.status !== "done" && sub.status !== "cancelled")) report.doneWithOpenSubtasks.push(item.shortId);

      // History and comments: its own, then each story's and its tasks', marked with where they were.
      const sources: { from: OldItem; mark: string | null; heading: string | null }[] = [{ from: item, mark: null, heading: null }];
      for (const story of stories) {
        const sub = subtaskIds.get(story.id)!;
        sources.push({ from: story, mark: sub, heading: `On subtask ${sub} (story \`${story.shortId}\`)` });
        for (const old of children(story.id)) sources.push({ from: old, mark: `${sub}.${old.shortId}`, heading: `On subtask ${sub} (story \`${story.shortId}\`, task \`${old.shortId}\`)` });
      }
      for (const old of ownTasks) sources.push({ from: old, mark: old.shortId, heading: `On task \`${old.shortId}\`` });
      const history: { key: string; entry: HistoryEntry }[] = [];
      const comments: Comment[] = [];
      for (const { from, mark, heading } of sources) {
        const filed = detail(from.id);
        for (const old of filed.history.filter((entry) => entry.item === from.id)) {
          const changes = [...old.changes, ...(old.overrode?.length ? [{ field: "overrode", from: null, to: old.overrode }] : [])];
          history.push({
            key: historyKey(old),
            entry: { taskId: item.id, action: old.action, changes: mark ? changes.map((change) => ({ ...change, field: `${mark}.${change.field}` })) : changes, actor: old.claimedBy, at: old.at },
          });
        }
        for (const old of [...filed.comments, ...filed.workLog]) {
          const body = withLinks(old);
          comments.push({ id: old.id, taskId: item.id, author: old.author, body: heading ? `${heading}:\n\n${body}` : body, createdAt: old.at });
        }
      }
      for (const { key, entry } of history.sort((a, b) => a.entry.at.localeCompare(b.entry.at))) {
        if (tracked("history", key) !== undefined) continue;
        db.prepare("INSERT INTO task_history (task_id, record) VALUES (?, ?)").run(entry.taskId, JSON.stringify(entry));
        track("history", key, entry.taskId);
        report.added.history++;
      }
      for (const comment of comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
        if (db.prepare("SELECT 1 FROM comments WHERE id = ?").get(comment.id)) continue;
        db.prepare("INSERT INTO comments (id, task_id, record) VALUES (?, ?, ?)").run(comment.id, comment.taskId, JSON.stringify(comment));
        report.added.comments++;
      }
    }

    // Short ids: each old one should still name its item, and a story's or old task's none.
    const all = new Tasks((db.prepare("SELECT record FROM tasks").all() as { record: string }[]).map((row) => JSON.parse(row.record) as Task));
    const allIds = [...(db.prepare("SELECT id FROM tasks").all() as { id: string }[]).map((row) => row.id)];
    for (const item of source.items) {
      const named = allIds.filter((id) => id.startsWith(item.shortId) && id !== item.id);
      if (!topIds.has(item.id)) {
        if (tracked("task", item.id) !== undefined && stored("tasks", item.id) !== undefined) report.stale.push(item.shortId);
        if (named.length) report.clashes.push({ shortId: item.shortId, item: item.id, why: `an old ${item.type}'s short id names task ${named.join(", ")} in waypoint` });
      } else if (!native.has(item.id) && all.get(item.id) && all.shortId(item.id) !== item.shortId) {
        report.clashes.push({ shortId: item.shortId, item: item.id, why: `in waypoint its short id is ${all.shortId(item.id)}, shared with ${named.join(", ")}` });
      }
    }

    const wrote = report.tasks.created + report.tasks.updated + report.labels.created + report.labels.updated + report.added.comments + report.added.history;
    return { result: report, wrote };
  });
}

// --- removing an import ----------------------------------------------------

export interface RemoveReport {
  dryRun: boolean;
  removed: { tasks: number; comments: number; history: number; labels: number };
  /** Tasks with an old item's id that the import never wrote, so waypoint made them: left alone. */
  leftAlone: string[];
  /** Labels the import made that a task left standing still carries: kept, so it names no missing label. */
  labelsKept: { id: string; name: string; tasks: string[] }[];
}

/**
 * Deletes what an import of `source`, of this shape or the one before it,
 * wrote: each task with an old item's id, its comments and history, and the
 * labels made for tags and epics. Nothing waypoint made itself.
 */
export function removeWorkTrackerImport(db: DatabaseSync, source: Pick<Source, "items" | "tags">, { dryRun = false } = {}): RemoveReport {
  db.exec(SCHEMA);
  const report: RemoveReport = { dryRun, removed: { tasks: 0, comments: 0, history: 0, labels: 0 }, leftAlone: [], labelsKept: [] };
  const tracked = (kind: string, key: string) => db.prepare("SELECT 1 FROM work_tracker_import WHERE kind = ? AND key = ?").get(kind, key) !== undefined;
  const count = (sql: string, id: string) => (db.prepare(sql).get(id) as { n: number }).n;
  return transaction(db, dryRun, () => {
    const taskIds = new Set((db.prepare("SELECT id FROM tasks").all() as { id: string }[]).map((row) => row.id));
    const doomed = new Set<string>();
    for (const item of source.items) {
      if (!taskIds.has(item.id)) continue;
      if (tracked("task", item.id)) doomed.add(item.id);
      else report.leftAlone.push(item.id);
    }
    for (const id of doomed) {
      report.removed.comments += count("SELECT COUNT(*) AS n FROM comments WHERE task_id = ?", id);
      report.removed.history += count("SELECT COUNT(*) AS n FROM task_history WHERE task_id = ?", id);
      db.prepare("DELETE FROM comments WHERE task_id = ?").run(id);
      db.prepare("DELETE FROM task_history WHERE task_id = ?").run(id);
      db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
      db.prepare("DELETE FROM work_tracker_import WHERE (kind = 'task' AND key = ?) OR (kind = 'history' AND value = ?)").run(id, id);
      report.removed.tasks++;
    }
    for (const item of source.items) db.prepare("DELETE FROM work_tracker_import WHERE kind = 'subtask' AND key = ?").run(item.id);

    const left = (db.prepare("SELECT record FROM tasks").all() as { record: string }[]).map((row) => JSON.parse(row.record) as Task);
    const ours = [...source.tags.map((tag) => tag.id), ...source.items.filter((item) => item.type === "epic").map((epic) => epicLabelId(epic.id))];
    for (const id of ours) {
      const row = db.prepare("SELECT record FROM labels WHERE id = ?").get(id) as { record: string } | undefined;
      if (!row || !tracked("label", id)) continue;
      const users = left.filter((task) => task.labels.includes(id)).map((task) => task.id);
      if (users.length) {
        report.labelsKept.push({ id, name: (JSON.parse(row.record) as Label).name, tasks: users });
        continue;
      }
      db.prepare("DELETE FROM labels WHERE id = ?").run(id);
      db.prepare("DELETE FROM work_tracker_import WHERE kind = 'label' AND key = ?").run(id);
      report.removed.labels++;
    }
    const { tasks, comments, history, labels } = report.removed;
    return { result: report, wrote: tasks + comments + history + labels };
  });
}

// --- reports ---------------------------------------------------------------

/** The report as lines for a person. */
export function describeReport(report: Report): string {
  const lines = [
    `${report.dryRun ? "Would import (dry run, nothing written)" : "Imported"} from work-tracker-service:`,
    `  items read: ${Object.entries(report.source.items).sort().map(([key, n]) => `${key} ${n}`).join(", ")}`,
    `  tags ${report.source.tags}, comments ${report.source.comments}, work-log entries ${report.source.workLog}, history entries ${report.source.history}`,
    `  tasks: ${report.tasks.created} created, ${report.tasks.updated} updated, ${report.tasks.unchanged} unchanged; ${report.subtasks} subtasks among them`,
    `  labels: ${report.labels.created} created, ${report.labels.updated} updated, ${report.labels.unchanged} unchanged`,
    `  added: ${report.added.comments} comments, ${report.added.history} history entries`,
    `  stories with no epic: ${report.ownTasks.stories.length}; old tasks with no story: ${report.ownTasks.tasks.length} (each a task of its own)`,
  ];
  const list = (title: string, entries: string[]) => entries.length && lines.push(`${title} (${entries.length}):`, ...entries.map((each) => `  ${each}`));
  const row = (title: string, entries: string[]) => entries.length && lines.push(`${title} (${entries.length}):`, `  ${entries.join(" ")}`);
  row("Stories with no epic", report.ownTasks.stories);
  row("Old tasks with no story", report.ownTasks.tasks);
  row("Made tasks by an earlier import, still there: run --remove, then import", report.stale);
  list("Left alone", report.leftAlone.map((each) => `${each.id}: ${each.why}`));
  list("Short-id clashes, for the person", report.clashes.map((each) => `${each.shortId} (${each.item}): ${each.why}`));
  list("Tags given a label waypoint already had", report.labelsShared.map((each) => `${each.tag} -> ${each.label}`));
  row("Done with criteria the tracker left unmet, ticked by the import", report.criteriaTickedAtImport);
  row("Done with criteria unmet", report.doneWithUnmetCriteria);
  row("Done with a subtask still open", report.doneWithOpenSubtasks);
  return `${lines.join("\n")}\n`;
}

/** The removal's report as lines for a person. */
export function describeRemoval(report: RemoveReport): string {
  const { tasks, comments, history, labels } = report.removed;
  const lines = [`${report.dryRun ? "Would remove (dry run, nothing written)" : "Removed"} what the work-tracker import wrote:`, `  ${tasks} tasks, ${comments} comments, ${history} history entries, ${labels} labels`];
  if (report.leftAlone.length) lines.push(`Left alone, made in waypoint with an old item's id (${report.leftAlone.length}):`, ...report.leftAlone.map((id) => `  ${id}`));
  if (report.labelsKept.length) lines.push(`Labels kept, carried by a task left standing (${report.labelsKept.length}):`, ...report.labelsKept.map((each) => `  ${each.name} (${each.id}): ${each.tasks.join(", ")}`));
  return `${lines.join("\n")}\n`;
}
