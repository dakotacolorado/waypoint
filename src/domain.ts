import { randomUUID } from "node:crypto";

/** Every status, in board order. `done` and `cancelled` are the closed statuses. */
export const STATUSES = ["backlog", "in_progress", "review", "done", "cancelled"] as const;
export type Status = (typeof STATUSES)[number];

export const CLOSED: readonly Status[] = ["done", "cancelled"];
/** Moving into one of these needs everything it depends on closed. */
export const STARTED: readonly Status[] = ["in_progress", "review", "done"];

/** Who checks that a task's work does what it should: an agent, or the person. */
export const VERIFIERS = ["agent", "person"] as const;
/** When they check it: before the work is released to its users, or after. */
export const VERIFY_WHEN = ["before_release", "after_release"] as const;

export interface Verification {
  by: (typeof VERIFIERS)[number];
  when: (typeof VERIFY_WHEN)[number];
}

export const SHORT_ID_LENGTH = 8;
export const MAX_LABELS = 20;
export const MAX_CRITERIA = 50;
export const MAX_SUBTASKS = 50;

export interface Criterion {
  id: string;
  text: string;
  met: boolean;
  metBy: string | null;
  metAt: string | null;
}

export interface Subtask {
  id: string;
  title: string;
  description: string;
  status: Status;
  dependsOn: string[];
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: Status;
  dependsOn: string[];
  subtasks: Subtask[];
  criteria: Criterion[];
  labels: string[];
  assignee: string | null;
  verification: Verification | null;
  createdAt: string;
  updatedAt: string;
}

export interface SubtaskView extends Subtask {
  blockedBy: string[];
}

/** A task as the API gives it: what it stores, and what the set says about it. */
export interface TaskView extends Omit<Task, "subtasks"> {
  shortId: string;
  subtasks: SubtaskView[];
  blockedBy: string[];
  ready: boolean;
}

export interface CriterionInput {
  id?: string;
  text?: string;
  met?: boolean;
}

export interface SubtaskInput {
  id?: string;
  title?: string;
  description?: string;
  status?: Status;
  dependsOn?: string[];
}

/** A task's fields as a request gives them, its task and label references already resolved to ids. */
export interface TaskInput {
  title?: string;
  description?: string;
  status?: Status;
  dependsOn?: string[];
  subtasks?: SubtaskInput[];
  criteria?: CriterionInput[];
  labels?: string[];
  assignee?: string | null;
  verification?: Verification | null;
}

/** The request is wrong: 400. */
export class ValidationError extends Error {}
/** No such thing: 404. */
export class NotFoundError extends Error {}
/** The request is well formed, but the tasks as they stand refuse it: 409. */
export class ConflictError extends Error {
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.details = details;
  }
}

export interface Change {
  field: string;
  from: unknown;
  to: unknown;
}

export interface HistoryEntry {
  taskId: string;
  action: "created" | "updated" | "deleted";
  changes: Change[];
  actor: string | null;
  at: string;
}

const RECORDED = ["title", "description", "status", "dependsOn", "subtasks", "criteria", "labels", "assignee", "verification"] as const;

/** The recorded fields that differ; a missing side reads as null throughout. */
export function changes(before: Task | null, after: Task | null): Change[] {
  return RECORDED.map((field) => ({ field, from: before?.[field] ?? null, to: after?.[field] ?? null })).filter(
    ({ from, to }) => JSON.stringify(from) !== JSON.stringify(to),
  );
}

/**
 * `given` merged over `current` by id: an entry with an id changes only the
 * fields it gives, one without is new, and one left out is gone. New entries
 * get the next ids in order, after every one `current` has.
 */
function merged<T extends { id: string }, I extends { id?: string }>(
  given: I[],
  current: T[],
  prefix: string,
  what: [one: string, many: string],
  fresh: (input: I, id: string) => T,
  update: (existing: T, input: I) => T,
): T[] {
  const known = new Map(current.map((each) => [each.id, each]));
  const ids = given.flatMap((each) => (each.id === undefined ? [] : [each.id]));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length) throw new ValidationError(`the task has no ${counted(unknown, ...what)}`);
  const twice = ids.filter((id, at) => ids.indexOf(id) !== at);
  if (twice.length) throw new ValidationError(`${what[0]} ${twice[0]} is given twice`);
  let next = Math.max(0, ...current.map((each) => Number(each.id.slice(prefix.length))));
  return given.map((each) => (each.id === undefined ? fresh(each, `${prefix}${++next}`) : update(known.get(each.id)!, each)));
}

export function criteriaFrom(given: CriterionInput[], current: Criterion[], actor: string | null, now: string): Criterion[] {
  const met = (criterion: Criterion, value: boolean | undefined): Criterion =>
    value === undefined || value === criterion.met ? criterion : { ...criterion, met: value, metBy: value ? actor : null, metAt: value ? now : null };
  return merged(
    given,
    current,
    "c",
    ["criterion", "criteria"],
    (input, id) => {
      if (!input.text) throw new ValidationError("a new criterion needs its text");
      return met({ id, text: input.text, met: false, metBy: null, metAt: null }, input.met);
    },
    (existing, input) => met({ ...existing, ...(input.text !== undefined && { text: input.text }) }, input.met),
  );
}

export function subtasksFrom(given: SubtaskInput[], current: Subtask[]): Subtask[] {
  return merged(
    given,
    current,
    "s",
    ["subtask", "subtasks"],
    (input, id) => {
      if (!input.title) throw new ValidationError("a new subtask needs its title");
      return { id, title: input.title, description: input.description ?? "", status: input.status ?? "backlog", dependsOn: input.dependsOn ?? [] };
    },
    (existing, input) => ({
      ...existing,
      ...Object.fromEntries(Object.entries(input).filter(([key, value]) => key !== "id" && value !== undefined)),
    }),
  );
}

/** `ids` after their noun, which agrees with how many there are: "criterion c1", "criteria c1, c2". */
const counted = (ids: string[], one: string, many: string) => `${ids.length === 1 ? one : many} ${ids.join(", ")}`;

/** "a is blocked by b: close it first", agreeing in number with `blockers`. */
const blockedMessage = (what: string, blockers: string[]) =>
  `${what} is blocked by ${blockers.join(", ")}: close ${blockers.length === 1 ? "it" : "them"} first`;

/** Those of `ids` that `status` says are not closed. */
const open = (ids: string[], status: (id: string) => Status | undefined) => ids.filter((id) => !CLOSED.includes(status(id) ?? "done"));

/** Whether following `dependsOn` from `start` comes back to it. */
function cycles(start: string, dependsOn: (id: string) => string[]): boolean {
  const seen = new Set<string>();
  const walk = (id: string): boolean => dependsOn(id).some((dep) => dep === start || (!seen.has(dep) && (seen.add(dep), walk(dep))));
  return walk(start);
}

export function subtaskViews(task: Task): SubtaskView[] {
  const status = (id: string) => task.subtasks.find((sub) => sub.id === id)?.status;
  return task.subtasks.map((sub) => ({ ...sub, blockedBy: open(sub.dependsOn, status) }));
}

/** Every task as one read saw it: what every rule about dependencies needs. */
export class Tasks {
  private readonly byId: Map<string, Task>;
  private shortIds?: Map<string, string>;

  constructor(tasks: Task[]) {
    this.byId = new Map(tasks.map((task) => [task.id, task]));
  }

  /** Oldest first; a tie in the order given, which the store gives as stored. */
  all(): Task[] {
    return [...this.byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): Task | undefined {
    return this.byId.get(id);
  }

  /** The task `ref` names, by its id or a prefix of it at least 8 characters long. */
  find(ref: string): Task {
    const exact = this.byId.get(ref);
    if (exact) return exact;
    const prefix = ref.toLowerCase();
    const matches = ref.length < SHORT_ID_LENGTH ? [] : [...this.byId.keys()].filter((id) => id.startsWith(prefix));
    if (matches.length > 1) throw new ConflictError(`${ref} is the start of more than one task's ID`, { matches: matches.sort() });
    if (!matches.length) throw new NotFoundError(`no task has the ID ${ref}`);
    return this.byId.get(matches[0]!)!;
  }

  /** `refs` as full task ids, each once. */
  ids(refs: string[]): string[] {
    return [...new Set(refs.map((ref) => this.find(ref).id))];
  }

  /** The shortest prefix of `id`, at least 8 characters, that no other task's id starts with. */
  shortId(id: string): string {
    if (!this.shortIds) {
      const ids = [...this.byId.keys()].sort();
      const shared = (a = "", b = "") => {
        let n = 0;
        while (n < a.length && a[n] === b[n]) n++;
        return n;
      };
      this.shortIds = new Map(ids.map((each, i) => [each, each.slice(0, Math.max(SHORT_ID_LENGTH, shared(each, ids[i - 1]) + 1, shared(each, ids[i + 1]) + 1))]));
    }
    return this.shortIds.get(id) ?? id.slice(0, SHORT_ID_LENGTH);
  }

  /** A new id whose first 8 characters start no other task's. */
  freshId(draw: () => string = randomUUID): string {
    const taken = new Set([...this.byId.keys()].map((id) => id.slice(0, SHORT_ID_LENGTH)));
    let id: string;
    do id = draw();
    while (taken.has(id.slice(0, SHORT_ID_LENGTH)));
    return id;
  }

  blockedBy(task: Task): string[] {
    return open(task.dependsOn, (id) => this.byId.get(id)?.status);
  }

  view(task: Task): TaskView {
    const blockedBy = this.blockedBy(task);
    return { ...task, shortId: this.shortId(task.id), subtasks: subtaskViews(task), blockedBy, ready: task.status === "backlog" && !blockedBy.length };
  }

  /** `input` applied to `current`, or a new task when there is none. */
  apply(current: Task | null, input: TaskInput, actor: string | null, now: string, id = current?.id ?? this.freshId()): Task {
    const base: Task = current ?? { id, title: "", description: "", status: "backlog", dependsOn: [], subtasks: [], criteria: [], labels: [], assignee: null, verification: null, createdAt: now, updatedAt: now };
    const next: Task = {
      ...base,
      ...(input.title !== undefined && { title: input.title }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.status !== undefined && { status: input.status }),
      ...(input.dependsOn !== undefined && { dependsOn: input.dependsOn }),
      ...(input.labels !== undefined && { labels: input.labels }),
      ...(input.assignee !== undefined && { assignee: input.assignee }),
      ...(input.verification !== undefined && { verification: input.verification }),
      ...(input.criteria !== undefined && { criteria: criteriaFrom(input.criteria, base.criteria, actor, now) }),
      ...(input.subtasks !== undefined && { subtasks: subtasksFrom(input.subtasks, base.subtasks) }),
      updatedAt: now,
    };
    // Cancelling a task cancels what is still open of its work.
    if (next.status === "cancelled" && base.status !== "cancelled") {
      next.subtasks = next.subtasks.map((sub) => (CLOSED.includes(sub.status) ? sub : { ...sub, status: "cancelled" }));
    }
    return next;
  }

  /** Throws for a write that leaves `next` wrong, given how it stood `before`. */
  check(before: Task | null, next: Task): void {
    for (const dep of next.dependsOn) {
      if (dep === next.id) throw new ValidationError("a task can't depend on itself");
      if (!this.byId.has(dep)) throw new NotFoundError(`no task has the ID ${dep}`);
    }
    const after = new Tasks([...this.byId.values()].filter((task) => task.id !== next.id).concat(next));
    if (next.dependsOn.length && cycles(next.id, (id) => after.get(id)?.dependsOn ?? [])) throw new ValidationError("that dependency makes a cycle");
    this.checkSubtasks(before, next);
    if (next.status !== before?.status && STARTED.includes(next.status)) {
      const blocked = after.blockedBy(next);
      if (blocked.length) {
        throw new ConflictError(blockedMessage(after.shortId(next.id), blocked.map((id) => after.shortId(id))), { blockedBy: blocked });
      }
    }
    if (next.status === "done") {
      const unmet = next.criteria.filter((criterion) => !criterion.met).map((criterion) => criterion.id);
      if (unmet.length) throw new ConflictError(`the task can't be done while ${counted(unmet, "criterion", "criteria")} ${unmet.length === 1 ? "is" : "are"} unmet`, { unmetCriteria: unmet });
      const openSubtasks = open(next.subtasks.map((sub) => sub.id), (id) => next.subtasks.find((sub) => sub.id === id)?.status);
      if (openSubtasks.length) throw new ConflictError(`the task can't be done while ${counted(openSubtasks, "subtask", "subtasks")} ${openSubtasks.length === 1 ? "is" : "are"} open`, { openSubtasks });
    }
  }

  private checkSubtasks(before: Task | null, next: Task): void {
    const ids = new Set(next.subtasks.map((sub) => sub.id));
    const was = new Map((before?.subtasks ?? []).map((sub) => [sub.id, sub]));
    const dependsOn = (id: string) => next.subtasks.find((sub) => sub.id === id)?.dependsOn ?? [];
    for (const sub of next.subtasks) {
      for (const dep of sub.dependsOn) {
        if (dep === sub.id) throw new ValidationError(`subtask ${sub.id} can't depend on itself`);
        if (!ids.has(dep)) throw new ValidationError(`subtask ${sub.id} depends on ${dep}, which the task doesn't have`);
      }
      if (sub.dependsOn.length && cycles(sub.id, dependsOn)) throw new ValidationError(`subtask ${sub.id}'s dependencies make a cycle`);
    }
    for (const sub of subtaskViews(next)) {
      if (sub.status !== was.get(sub.id)?.status && STARTED.includes(sub.status) && sub.blockedBy.length) {
        throw new ConflictError(blockedMessage(`subtask ${sub.id}`, sub.blockedBy), { blockedBy: sub.blockedBy });
      }
    }
  }

  /** Throws while another task depends on `id`. */
  checkDelete(id: string): void {
    const dependents = this.all().filter((task) => task.dependsOn.includes(id));
    if (dependents.length) {
      const names = dependents.map((task) => this.shortId(task.id)).join(", ");
      throw new ConflictError(`${names} ${dependents.length === 1 ? "depends" : "depend"} on ${this.shortId(id)}: remove the dependency first`);
    }
  }
}
