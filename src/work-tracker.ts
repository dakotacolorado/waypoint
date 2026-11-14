import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Tasks, type Criterion, type HistoryEntry, type Status, type Subtask, type Task } from "./domain.ts";
import type { Label } from "./labels.ts";
import type { Comment } from "./store.ts";

/**
 * A one-way copy of work-tracker-service's items into waypoint, keeping their
 * ids, timestamps and authors, so it writes the database directly rather than
 * through the API, which draws its own. Each old epic and story is a task with
 * its id; each old task is a subtask of its story's task. Run again, it adds
 * only what is new and updates only what it wrote and nobody has changed since.
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

/** The label naming an old epic, on it and on each of its stories. */
export const epicLabelName = (epic: Pick<OldItem, "shortId">) => `epic:${epic.shortId}`;

/** A UUID drawn from `seed`, so a second run makes the same one. */
export function seededId(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

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

/** An old task's body, then where it came from, its criteria and any dependency a subtask can't hold. */
function subtaskDescription(task: OldItem, outside: OldItem[], missing: string[]): string {
  const lines = [`Imported from work-tracker task \`${task.id}\` (\`${task.shortId}\`).`];
  if (task.acceptanceCriteria.length) {
    const met = new Set(task.met.map((tick) => tick.criterion));
    lines.push("", "Acceptance criteria:", ...task.acceptanceCriteria.map((text) => `- [${met.has(text) ? "x" : " "}] ${text}`));
  }
  if (outside.length || missing.length) {
    lines.push("", `Depended on, outside this task: ${[...outside.map((dep) => `\`${dep.shortId}\` (${dep.type})`), ...missing.map((id) => `\`${id}\``)].join(", ")}.`);
  }
  return [task.body, lines.join("\n")].filter(Boolean).join("\n\n---\n");
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
}

/** The store refuses to commit a write decided before this one, and decides it again. */
function bumpVersion(db: DatabaseSync): void {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value: string } | undefined;
  db.prepare("INSERT INTO meta (key, value) VALUES ('version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(String(Number(row?.value ?? 0) + 1));
}

/**
 * Copies `source` into the store's database in one transaction. Safe while
 * the server runs on it: the version it bumps makes any write decided before
 * it decide again. With `dryRun`, reports what it would do and writes nothing.
 */
export function importWorkTracker(db: DatabaseSync, source: Source, { dryRun = false } = {}): Report {
  db.exec(SCHEMA);
  const byId = new Map(source.items.map((item) => [item.id, item]));
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

  db.exec("BEGIN IMMEDIATE");
  try {
    // Labels: each tag, and one per epic with stories.
    const nativeByName = new Map(
      (db.prepare("SELECT id, record FROM labels").all() as { id: string; record: string }[])
        .filter((row) => tracked("label", row.id) === undefined)
        .map((row) => [(JSON.parse(row.record) as Label).name.toLowerCase(), row.id]),
    );
    const labelId = new Map<string, string>();
    const putLabel = (key: string, label: Label) => {
      const shared = nativeByName.get(label.name.toLowerCase());
      if (shared && shared !== label.id) {
        report.labelsShared.push({ tag: label.name, label: shared });
        labelId.set(key, shared);
        return;
      }
      upsert("labels", "label", label, report.labels);
      labelId.set(key, label.id);
    };
    for (const tag of source.tags) {
      putLabel(tag.id, { id: tag.id, name: tag.value, color: tag.color, description: tag.description, createdAt: tag.createdAt, updatedAt: tag.updatedAt });
    }
    const epicsWithStories = new Set(source.items.filter((item) => item.type === "story" && item.parent).map((item) => item.parent!));
    for (const epic of source.items.filter((item) => item.type === "epic" && epicsWithStories.has(item.id))) {
      const id = seededId(`work-tracker epic label ${epic.id}`);
      putLabel(epic.id, { id, name: epicLabelName(epic), color: "#808080", description: epic.title.slice(0, 500), createdAt: epic.createdAt, updatedAt: epic.createdAt });
    }

    // Tasks: every epic and story, its old tasks as subtasks.
    const tasksOf = new Map<string, OldItem[]>();
    for (const item of source.items.filter((each) => each.type === "task").sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      tasksOf.set(item.parent!, [...(tasksOf.get(item.parent!) ?? []), item]);
    }
    const subtaskIds = new Map<string, string>();
    for (const [story, tasks] of tasksOf) {
      const ids = tasks.map((task) => tracked("subtask", task.id)).filter((at): at is string => at?.startsWith(`${story}/`) ?? false);
      let next = Math.max(0, ...ids.map((at) => Number(at.split("/s")[1])));
      for (const task of tasks) {
        const was = tracked("subtask", task.id);
        subtaskIds.set(task.id, was?.startsWith(`${story}/`) ? was.split("/")[1]! : `s${++next}`);
      }
    }

    const ours = source.items.filter((item) => item.type !== "task");
    for (const item of ours) {
      const children = tasksOf.get(item.id) ?? [];
      const subtasks: Subtask[] = children.map((task) => {
        const deps = task.dependsOn.map((id) => byId.get(id));
        const siblings = deps.filter((dep): dep is OldItem => dep?.type === "task" && dep.parent === item.id);
        const outside = deps.filter((dep): dep is OldItem => dep !== undefined && !siblings.includes(dep));
        const missing = task.dependsOn.filter((id) => !byId.has(id));
        return {
          id: subtaskIds.get(task.id)!,
          title: task.title,
          description: subtaskDescription(task, outside, missing),
          status: statusOf(task),
          dependsOn: siblings.map((dep) => subtaskIds.get(dep.id)!),
        };
      });
      const parentLabel = item.type === "epic" ? labelId.get(item.id) : item.parent ? labelId.get(item.parent) : undefined;
      const labels = [...new Set([...item.tags.map((tag) => labelId.get(tag) ?? tag), ...(parentLabel ? [parentLabel] : [])])];
      const task: Task = {
        id: item.id,
        title: item.title,
        description: item.body,
        status: statusOf(item),
        dependsOn: item.dependsOn.filter((id) => byId.has(id) && byId.get(id)!.type !== "task"),
        subtasks,
        criteria: criteriaOf(item, detail(item.id).history),
        labels,
        assignee: item.state === "open" ? item.heldBy : null,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      };
      if (!upsert("tasks", "task", task, report.tasks)) continue;
      report.subtasks += subtasks.length;
      for (const task of children) track("subtask", task.id, `${item.id}/${subtaskIds.get(task.id)}`);
      if (task.criteria.some((criterion) => criterion.metBy === IMPORT_ACTOR && !item.met.some((tick) => tick.criterion === criterion.text))) report.criteriaTickedAtImport.push(item.shortId);
      if (task.status === "done" && task.criteria.some((criterion) => !criterion.met)) report.doneWithUnmetCriteria.push(item.shortId);

      // History and comments: its own, then its old tasks', each marked with the subtask it was.
      const sources = [{ item, mark: null as string | null }, ...children.map((child) => ({ item: child, mark: subtaskIds.get(child.id)! }))];
      const history: { key: string; entry: HistoryEntry }[] = [];
      const comments: Comment[] = [];
      for (const { item: from, mark } of sources) {
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
          comments.push({ id: old.id, taskId: item.id, author: old.author, body: mark ? `On subtask ${mark} (work-tracker task \`${from.shortId}\`):\n\n${body}` : body, createdAt: old.at });
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

    // Short ids: each old one should still name its item, an old task's its story's subtask.
    const all = new Tasks((db.prepare("SELECT record FROM tasks").all() as { record: string }[]).map((row) => JSON.parse(row.record) as Task));
    const allIds = [...(db.prepare("SELECT id FROM tasks").all() as { id: string }[]).map((row) => row.id)];
    for (const item of source.items) {
      const named = allIds.filter((id) => id.startsWith(item.shortId));
      if (item.type === "task") {
        if (named.length) report.clashes.push({ shortId: item.shortId, item: item.id, why: `an old task's short id, now ${subtaskIds.get(item.id)} of ${byId.get(item.parent!)?.shortId}, names task ${named.join(", ")} in waypoint` });
      } else if (!native.has(item.id) && all.get(item.id) && all.shortId(item.id) !== item.shortId) {
        report.clashes.push({ shortId: item.shortId, item: item.id, why: `in waypoint its short id is ${all.shortId(item.id)}, shared with ${named.filter((id) => id !== item.id).join(", ")}` });
      }
    }

    const wrote =
      report.tasks.created + report.tasks.updated + report.labels.created + report.labels.updated + report.added.comments + report.added.history;
    if (dryRun) db.exec("ROLLBACK");
    else {
      if (wrote) bumpVersion(db);
      db.exec("COMMIT");
    }
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return report;
}

/** The report as lines for a person. */
export function describeReport(report: Report): string {
  const lines = [
    `${report.dryRun ? "Would import (dry run, nothing written)" : "Imported"} from work-tracker-service:`,
    `  items read: ${Object.entries(report.source.items).sort().map(([key, n]) => `${key} ${n}`).join(", ")}`,
    `  tags ${report.source.tags}, comments ${report.source.comments}, work-log entries ${report.source.workLog}, history entries ${report.source.history}`,
    `  tasks: ${report.tasks.created} created, ${report.tasks.updated} updated, ${report.tasks.unchanged} unchanged; ${report.subtasks} subtasks among them`,
    `  labels: ${report.labels.created} created, ${report.labels.updated} updated, ${report.labels.unchanged} unchanged`,
    `  added: ${report.added.comments} comments, ${report.added.history} history entries`,
  ];
  const list = (title: string, entries: string[]) => entries.length && lines.push(`${title} (${entries.length}):`, ...entries.map((each) => `  ${each}`));
  list("Left alone", report.leftAlone.map((each) => `${each.id}: ${each.why}`));
  list("Short-id clashes, for the person", report.clashes.map((each) => `${each.shortId} (${each.item}): ${each.why}`));
  list("Tags given a label waypoint already had", report.labelsShared.map((each) => `${each.tag} -> ${each.label}`));
  if (report.criteriaTickedAtImport.length) lines.push(`Done with criteria the tracker left unmet, ticked by the import (${report.criteriaTickedAtImport.length}):`, `  ${report.criteriaTickedAtImport.join(" ")}`);
  if (report.doneWithUnmetCriteria.length) lines.push(`Done with criteria unmet (${report.doneWithUnmetCriteria.length}):`, `  ${report.doneWithUnmetCriteria.join(" ")}`);
  return `${lines.join("\n")}\n`;
}
