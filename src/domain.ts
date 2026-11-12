import { randomUUID } from "node:crypto";
import type { z } from "@hono/zod-openapi";
import type {
  AssignmentSchema,
  ChangeSchema,
  CommentSchema,
  DraftSchema,
  HistoryEntrySchema,
  PatchSchema,
  TickSchema,
  WorkItemSchema,
  WorkLogEntrySchema,
} from "./schema.ts";

/** Board columns, in order. */
/** The queue's running limit until the person sets one, so nothing runs alongside what ran before it. */
export const DEFAULT_LIMIT = 1;
export const MAX_LIMIT = 10;

export const STATUSES = ["backlog", "ready", "in_progress", "review", "done"] as const;

export const STATES = ["open", "closed"] as const;

export const CLOSED_REASONS = ["completed", "not_planned"] as const;

/** Broadest first. */
export const TYPES = ["epic", "story", "task"] as const;

/** Settable fields the service may compute instead of reading back as set. */
export const DERIVABLE = ["status"] as const;

export const ACTIONS = ["created", "updated", "deleted"] as const;

/** What is written on an item besides its fields: a comment to whoever reads it, or a work-log entry of what was done. */
export const NOTE_KINDS = ["comment", "work"] as const;

/** The most tags one item carries. */
export const MAX_TAGS = 20;

/** The stored fields a history entry compares. */
export const RECORDED = [
  "type",
  "title",
  "body",
  "acceptanceCriteria",
  "met",
  "status",
  "heldBy",
  "reviewedBy",
  "state",
  "closedReason",
  "parent",
  "dependsOn",
  "queuedAt",
  "tags",
  "assignment",
] as const;

export type Status = (typeof STATUSES)[number];
const STARTED: readonly Status[] = ["in_progress", "review", "done"];
const UNSTARTED: readonly Status[] = ["backlog", "ready"];
/** The statuses an item keeps `heldBy` through, while open. */
const HELD: readonly Status[] = ["in_progress", "review"];
export type Type = (typeof TYPES)[number];
export type State = (typeof STATES)[number];
export type ClosedReason = (typeof CLOSED_REASONS)[number];
export type Derivable = (typeof DERIVABLE)[number];
export type Action = (typeof ACTIONS)[number];

/** Every item but an epic has exactly this parent type, so the breakdown is always three deep. */
export const PARENT_TYPE: Record<Type, Type | null> = { epic: null, story: "epic", task: "story" };

export type WorkItemProps = z.infer<typeof WorkItemSchema>;
export type Draft = z.infer<typeof DraftSchema>;
export type Patch = z.infer<typeof PatchSchema>;
export type Change = z.infer<typeof ChangeSchema>;
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;
export type Tick = z.infer<typeof TickSchema>;
export type Assignment = z.infer<typeof AssignmentSchema>;
export type Comment = z.infer<typeof CommentSchema>;
export type WorkLogEntry = z.infer<typeof WorkLogEntrySchema>;
export type NoteKind = (typeof NOTE_KINDS)[number];
/** Comments and work-log entries are stored alike, told apart by `kind`; a comment has no links. */
export type Note = WorkLogEntry & { kind: NoteKind };

/** A note to store on `item`, said by `author`, now. */
export function note(item: string, kind: NoteKind, body: string, links: string[], author: string | null): Note {
  return { id: randomUUID(), item, kind, author, at: new Date().toISOString(), body, links };
}

type Unrecorded = Exclude<
  keyof WorkItemProps,
  "id" | "createdAt" | "updatedAt" | (typeof RECORDED)[number]
>;
// Fails to compile, naming the field, when a stored field is added without being recorded.
const everyFieldRecorded: [Unrecorded] extends [never] ? true : Unrecorded = true;
void everyFieldRecorded;

/** An entry and every item whose history it belongs to: the one written and all above it. */
export interface Filed {
  entry: HistoryEntry;
  under: string[];
}

/** A stored item plus the fields derived from the rest of the set. */
export interface WorkItemView extends WorkItemProps {
  /** See `Graph.shortId`. */
  shortId: string;
  /** Derived from the children when there are any; see `Graph.status`. */
  status: Status;
  children: string[];
  /** See `Graph.blockedBy`. */
  blockedBy: string[];
  /** `done` before every dependency is `done` or closed; see `Graph.finishedEarly`. */
  finishedEarly: boolean;
  /** See `Graph.queue`. */
  queuePosition: number | null;
}

export class WorkItem {
  readonly id!: string;
  readonly type!: Type;
  readonly title!: string;
  readonly body!: string;
  readonly acceptanceCriteria!: string[];
  readonly met!: Tick[];
  readonly status!: Status;
  readonly state!: State;
  readonly closedReason!: ClosedReason | null;
  readonly parent!: string | null;
  readonly dependsOn!: string[];
  readonly createdAt!: string;
  readonly updatedAt!: string;
  readonly heldBy!: string | null;
  readonly reviewedBy!: string | null;
  readonly queuedAt!: string | null;
  readonly tags!: string[];
  readonly assignment!: Assignment | null;

  constructor(props: WorkItemProps) {
    const held = props.state === "open" && HELD.includes(props.status);
    // A tick is on a criterion's text: once that text is gone, so is the tick.
    const met = props.acceptanceCriteria.flatMap((criterion) => props.met.find((tick) => tick.criterion === criterion) ?? []);
    // Closing or starting an item takes it off the queue in the write that does it.
    const queuable = props.state === "open" && UNSTARTED.includes(props.status);
    Object.assign(this, { ...props, met, heldBy: held ? props.heldBy : null, queuedAt: queuable ? props.queuedAt : null });
  }

  /** `by` is the write's `claimed-by`; it holds the item if the write starts it. */
  static create(
    draft: Draft,
    by: string | null = null,
    now = new Date().toISOString(),
    id: string = randomUUID(),
  ): WorkItem {
    return new WorkItem({
      ...draft,
      met: [],
      id,
      state: "open",
      closedReason: null,
      createdAt: now,
      updatedAt: now,
      heldBy: draft.status === "in_progress" ? by : null,
      reviewedBy: null,
      queuedAt: null,
      tags: [],
      assignment: null,
    });
  }

  /** `by` is the write's `claimed-by`; it holds the item if the write moves it to `in_progress`. */
  patched(patch: Patch, by: string | null = null, now = new Date().toISOString()): WorkItem {
    const { met: named, force: _force, queued, tags: _tags, ...fields } = patch;
    const next = { ...this.toJSON(), ...fields, updatedAt: now };
    if (queued === false) next.queuedAt = null;
    if (queued === true) next.queuedAt = this.queuedAt ?? now;
    if (named !== undefined) {
      const unknown = named.filter((criterion) => !next.acceptanceCriteria.includes(criterion));
      if (unknown.length) throw new GraphError(`met names no criterion of this item: ${unknown.map((each) => `"${each}"`).join(", ")}`);
      next.met = named.map((criterion) => this.met.find((tick) => tick.criterion === criterion) ?? { criterion, by, at: now });
    }
    if (next.state === "open") next.closedReason = null;
    if (next.state === "closed" && this.state === "open") next.assignment = ended(this.assignment, now, `the item was closed as ${next.closedReason}`);
    if (next.status === "in_progress" && this.status !== "in_progress") next.heldBy = by;
    return new WorkItem(next);
  }

  /**
   * With `criterion` ticked by `by` at `now`, the other ticks untouched; itself when
   * already ticked. Throws for a criterion the item does not have.
   */
  ticked(criterion: string, by: string | null, now = new Date().toISOString()): WorkItem {
    this.checkCriterion(criterion);
    if (this.met.some((tick) => tick.criterion === criterion)) return this;
    return new WorkItem({ ...this.toJSON(), met: [...this.met, { criterion, by, at: now }], updatedAt: now });
  }

  /** With `criterion` unticked, the other ticks untouched; itself when not ticked. Throws as `ticked`. */
  unticked(criterion: string, now = new Date().toISOString()): WorkItem {
    this.checkCriterion(criterion);
    if (!this.met.some((tick) => tick.criterion === criterion)) return this;
    return new WorkItem({ ...this.toJSON(), met: this.met.filter((tick) => tick.criterion !== criterion), updatedAt: now });
  }

  private checkCriterion(criterion: string): void {
    if (!this.acceptanceCriteria.includes(criterion)) throw new GraphError(`no criterion of this item reads "${criterion}"`);
  }

  /** Carrying `tags` instead; tags are written by their own routes only, never by a patch. */
  tagged(tags: string[], now = new Date().toISOString()): WorkItem {
    return new WorkItem({ ...this.toJSON(), tags, updatedAt: now });
  }

  toJSON(): WorkItemProps {
    return { ...this } as WorkItemProps;
  }
}

/** `assignment` ended at `at` for `why`, unless it already had. */
export const ended = (assignment: Assignment | null, at: string, why: string): Assignment | null =>
  assignment && !assignment.ended ? { ...assignment, ended: { at, why } } : assignment;

export class GraphError extends Error {}

/** A write only the person may make, sent by a worker: a `force` past `blockedBy`, or an epic's sign-off. */
export class ForbiddenError extends GraphError {}

/** A move refused while work it depends on is unfinished. */
export class BlockedError extends GraphError {
  readonly blockedBy: string[];

  constructor(message: string, blockedBy: string[]) {
    super(message);
    this.blockedBy = blockedBy;
  }
}

/**
 * A short id is never shorter than this. Each new id is drawn to differ from
 * every other in its first this many characters, so a short id once read back
 * never comes to name a second item.
 */
export const SHORT_ID_LENGTH = 8;

/** An id given as a prefix that more than one item's id starts with. */
export class AmbiguousIdError extends Error {
  readonly matches: string[];

  constructor(ref: string, matches: string[]) {
    super(`${ref} is the start of more than one item's id: ${matches.join(", ")}`);
    this.matches = matches;
  }
}

/** The recorded fields that differ; a missing side reads as null throughout. */
export function changes(before: WorkItem | null, after: WorkItem | null): Change[] {
  const value = (item: WorkItem | null, field: (typeof RECORDED)[number]) =>
    field === "met" ? (item?.met.map((tick) => tick.criterion) ?? null) : (item?.[field] ?? null);
  return RECORDED.map((field) => ({ field, from: value(before, field), to: value(after, field) })).filter(
    ({ from, to }) => JSON.stringify(from) !== JSON.stringify(to),
  );
}

export function sameTags(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((tag, at) => tag === b[at]);
}

/**
 * The whole item set, which is what every relationship question needs: a
 * child's parent, a parent's children, and whether anything upstream is
 * unfinished.
 */
export class Graph {
  private readonly byId: Map<string, WorkItem>;
  private readonly derivedStatus = new Map<string, Status>();
  private shortIds?: Map<string, string>;
  private queued?: string[];

  constructor(items: WorkItem[]) {
    this.byId = new Map(items.map((item) => [item.id, item]));
  }

  get(id: string): WorkItem | undefined {
    return this.byId.get(id);
  }

  /**
   * The id of the one item `ref` names, as its full id or a prefix of at least
   * `SHORT_ID_LENGTH` characters; `ref` itself when it names none, so the caller
   * answers as for any unknown id. Throws AmbiguousIdError when it names several.
   */
  resolve(ref: string): string {
    if (this.byId.has(ref) || ref.length < SHORT_ID_LENGTH) return ref;
    const prefix = ref.toLowerCase();
    const matches = [...this.byId.keys()].filter((id) => id.startsWith(prefix));
    if (matches.length > 1) throw new AmbiguousIdError(ref, matches.sort());
    return matches[0] ?? ref;
  }

  /** `fields` with `parent` and `dependsOn` resolved to full ids. */
  resolveRefs<T extends { parent?: string | null; dependsOn?: string[] }>(fields: T): T {
    const { parent, dependsOn } = fields;
    return {
      ...fields,
      ...(parent != null && { parent: this.resolve(parent) }),
      ...(dependsOn !== undefined && { dependsOn: dependsOn.map((ref) => this.resolve(ref)) }),
    };
  }

  /** The shortest prefix of `id`, at least `SHORT_ID_LENGTH` long, that no other item's id starts with. */
  shortId(id: string): string {
    if (!this.shortIds) {
      // Sorted, an id shares its longest prefix with a neighbour.
      const ids = [...this.byId.keys()].sort();
      const shared = (a = "", b = "") => {
        let n = 0;
        while (n < a.length && a[n] === b[n]) n++;
        return n;
      };
      this.shortIds = new Map(
        ids.map((each, i) => {
          const length = Math.max(shared(each, ids[i - 1]), shared(each, ids[i + 1])) + 1;
          return [each, each.slice(0, Math.max(SHORT_ID_LENGTH, length))];
        }),
      );
    }
    return this.shortIds.get(id) ?? id.slice(0, SHORT_ID_LENGTH);
  }

  /** A new id whose first `SHORT_ID_LENGTH` characters start no other item's. */
  freshId(draw: () => string = randomUUID): string {
    const taken = new Set([...this.byId.keys()].map((id) => id.slice(0, SHORT_ID_LENGTH)));
    let id: string;
    do id = draw();
    while (taken.has(id.slice(0, SHORT_ID_LENGTH)));
    return id;
  }

  /** Stored on the child only, so there is one place a parent can be wrong. */
  childrenOf(id: string): string[] {
    return [...this.byId.values()].filter((item) => item.parent === id).map((item) => item.id);
  }

  /** `id` itself, its parent, and so on to the top; stops at a stored cycle. */
  ancestorsOf(id: string | null): WorkItem[] {
    const chain: WorkItem[] = [];
    for (let at = id === null ? undefined : this.byId.get(id); at && !chain.includes(at); ) {
      chain.push(at);
      at = at.parent === null ? undefined : this.byId.get(at.parent);
    }
    return chain;
  }

  /**
   * The write that took `before` to `after`, filed under every item above
   * either, as the set stood.
   */
  filed(
    action: Action,
    before: WorkItem | null,
    after: WorkItem | null,
    at: string,
    claimedBy: string | null,
    overrode: string[] = [],
  ): Filed {
    const item = (after ?? before)!.id;
    const above = this.ancestorsOf(before?.parent ?? null).concat(
      this.ancestorsOf(after?.parent ?? null),
    );
    return {
      entry: { item, action, changes: changes(before, after), at, claimedBy, overrode },
      under: [...new Set([item, ...above.map((other) => other.id)])],
    };
  }

  /**
   * Closing a parent closes what is still open beneath it, for the same
   * reason and at the same time; reopening opens only the item reopened.
   */
  closedBeneath(before: WorkItem, after: WorkItem): WorkItem[] {
    if (before.state !== "open" || after.state !== "closed") return [];
    const beneath: WorkItem[] = [];
    const walk = (id: string) => {
      for (const child of this.childrenOf(id)) {
        const item = this.get(child)!;
        if (item.state === "open") {
          beneath.push(
            new WorkItem({
              ...item.toJSON(),
              state: "closed",
              closedReason: after.closedReason,
              updatedAt: after.updatedAt,
              assignment: ended(item.assignment, after.updatedAt, `${this.shortId(after.id)} above it was closed as ${after.closedReason}`),
            }),
          );
        }
        walk(child);
      }
    };
    walk(after.id);
    return beneath;
  }

  /**
   * Each item beneath `id`, open or closed, whose tags `retag` changes, carrying
   * the tags it gives; those it leaves as they were are left out. Stops at a
   * stored cycle.
   */
  retaggedBeneath(id: string, retag: (tags: string[]) => string[], at: string): WorkItem[] {
    const seen = new Set([id]);
    const changed: WorkItem[] = [];
    const walk = (parent: string) => {
      for (const child of this.childrenOf(parent)) {
        if (seen.has(child)) continue;
        seen.add(child);
        const item = this.get(child)!;
        const tags = retag(item.tags);
        if (!sameTags(tags, item.tags)) changed.push(item.tagged(tags, at));
        walk(child);
      }
    };
    walk(id);
    return changed;
  }

  /**
   * The writes that give `current` the `assignment`: an item whose status is
   * its own moves to `in_progress` held by the assignment's name, and it and
   * everything beneath it leave the queue, since its agent leads all of it.
   * Throws BlockedError as `checkStart` does. `before` is what it writes over, for `unassigned`.
   */
  assigned(current: WorkItem, assignment: Assignment, now: string): { put: WorkItem[]; before: WorkItem[] } {
    const own = !this.derived(current).length;
    const next = new WorkItem({
      ...current.toJSON(),
      assignment,
      updatedAt: now,
      queuedAt: null,
      ...(own && { status: "in_progress", heldBy: assignment.name }),
    });
    // A parent's status stays derived, so its assignment is checked as its Start: a started status written to it.
    if (own) this.checkStart(current, next);
    else this.checkStart(current, new WorkItem({ ...next.toJSON(), status: "in_progress" }), true);
    const queuedBeneath = this.beneath(current.id)
      .map((id) => this.byId.get(id)!)
      .filter((item) => item.queuedAt !== null);
    return {
      put: [next, ...queuedBeneath.map((item) => new WorkItem({ ...item.toJSON(), queuedAt: null, updatedAt: now }))],
      before: [current, ...queuedBeneath],
    };
  }

  /**
   * The writes that undo `assigned`, given what it wrote over as `before`; empty
   * when another assignment has replaced it. The status, and each place on the
   * queue, goes back only if it is still what the assignment left.
   */
  unassigned(before: WorkItem[], assignment: Assignment, now: string): WorkItem[] {
    const [was, ...queuedBeneath] = before;
    const current = this.byId.get(was!.id);
    if (current?.assignment?.id !== assignment.id) return [];
    const ours = current.heldBy === assignment.name;
    const moved = ours && current.status === "in_progress" && was!.status !== "in_progress";
    const item = new WorkItem({
      ...current.toJSON(),
      assignment: was!.assignment,
      updatedAt: now,
      ...(ours && { heldBy: was!.heldBy }),
      ...(moved && { status: was!.status }),
      ...(current.queuedAt === null && { queuedAt: was!.queuedAt }),
    });
    const requeued = queuedBeneath.flatMap((each) => {
      const after = this.byId.get(each.id);
      return after && after.queuedAt === null ? [new WorkItem({ ...after.toJSON(), queuedAt: each.queuedAt, updatedAt: now })] : [];
    });
    return [item, ...requeued];
  }

  /** Every item below `id`, at any depth. */
  beneath(id: string): string[] {
    return this.childrenOf(id).flatMap((child) => [child, ...this.beneath(child)]);
  }

  /**
   * Each dependency of `item`, of any item above it, or of any open descendant
   * not yet `done`, that is not `settled` or no longer known, at every status.
   * A parent's status follows its children's, so a child starting would start
   * a parent still waiting, and a parent can start only by a child starting.
   * Descendants give their own `dependsOn`, not their `blockedBy`, which holds
   * the parent's; one on `item` or inside its subtree is work the parent does.
   */
  blockedBy(item: WorkItem): string[] {
    const chain = [item, ...this.ancestorsOf(item.parent).filter((above) => above.id !== item.id)];
    const subtree = new Set([item.id]);
    const below: WorkItem[] = [];
    const walk = (id: string, open: boolean) => {
      for (const childId of this.childrenOf(id)) {
        if (subtree.has(childId)) continue;
        subtree.add(childId);
        const child = this.byId.get(childId)!;
        const waiting = open && !this.settled(child);
        if (waiting) below.push(child);
        walk(childId, waiting);
      }
    };
    walk(item.id, true);
    const outside = below.flatMap((each) => each.dependsOn).filter((id) => !subtree.has(id));
    return [...new Set([...chain.flatMap((each) => each.dependsOn), ...outside])].filter((id) => {
      const dependency = this.byId.get(id);
      return !dependency || !this.settled(dependency);
    });
  }

  /**
   * Throws BlockedError when the write taking `before` to `after` moves it to
   * `in_progress`, `review` or `done`, or moves it under a new parent while
   * there, and `blockedBy` is not empty. A write that leaves a started item
   * where it is passes, so work started before a dependency was added stays put.
   * A parent's status ignores what is written to it and moves only with a
   * child's, which `blockedBy` checks against every item above that child; a
   * started status `written` to a parent not yet reading started is its Start,
   * checked against what blocks its children too.
   */
  checkStart(before: WorkItem | null, after: WorkItem, written = before === null || before.status !== after.status): void {
    if (!STARTED.includes(after.status)) return;
    if (this.derived(after).length) {
      if (!written || STARTED.includes(this.status(after))) return;
    } else if (before && before.status === after.status && before.parent === after.parent) return;
    const blocking = this.blockedBy(after);
    if (!blocking.length) return;
    const named = blocking.map((id) => {
      const dependency = this.byId.get(id);
      return dependency ? `${this.shortId(id)} "${dependency.title}" (${this.status(dependency)})` : `${id} (no longer known)`;
    });
    throw new BlockedError(
      `cannot move to ${after.status} until every dependency is done or closed; still waiting on ${named.join(", ")}`,
      blocking,
    );
  }

  /**
   * `checkStart`, except that a `force` from a write with no `claimed-by`, as
   * the person's from the page, lets the move through: returns what it moved
   * past, for the history entry to record.
   */
  overriding(before: WorkItem, after: WorkItem, force: boolean, claimedBy: string | null, written?: boolean): string[] {
    if (force && claimedBy !== null) {
      throw new ForbiddenError(
        `only the person may force a move past unfinished dependencies, not ${claimedBy}: wait until each in blockedBy is done or closed`,
      );
    }
    try {
      this.checkStart(before, after, written);
      return [];
    } catch (err) {
      if (force && err instanceof BlockedError) return err.blockedBy;
      throw err;
    }
  }

  /**
   * Closing an epic that has children as `completed` is the person's sign-off,
   * so a write with a `claimed-by`, as every worker's is, may not make it.
   */
  checkSignOff(before: WorkItem, after: WorkItem, claimedBy: string | null): void {
    if (claimedBy === null || after.type !== "epic" || !this.childrenOf(after.id).length) return;
    if (before.state === "closed" || after.state !== "closed" || after.closedReason !== "completed") return;
    throw new ForbiddenError(
      `only the person closes an epic with children as completed, not ${claimedBy}: page waiting naming the epic, and the person closes it from its review panel`,
    );
  }

  /**
   * Throws GraphError when a write's `queued: true` leaves `after` where it
   * cannot wait to start: closed, or reading a started status, which on a
   * parent is the one derived from its children.
   */
  checkQueue(after: WorkItem, queued: boolean | undefined): void {
    if (queued !== true) return;
    const status = UNSTARTED.includes(this.status(after)) ? after.status : this.status(after);
    const why =
      after.state === "closed"
        ? "a closed item cannot be queued"
        : after.queuedAt === null || !UNSTARTED.includes(status)
          ? `an item at ${status} cannot be queued: only one in backlog or ready waits to start`
          : null;
    if (why) throw new GraphError(why);
  }

  /**
   * Ids of the items waiting to start, next first: in the order queued. One
   * whose status is derived leaves it while its children read as started.
   */
  queue(): string[] {
    if (!this.queued) {
      this.queued = [...this.byId.values()]
        .filter((item) => item.queuedAt !== null && UNSTARTED.includes(this.status(item)))
        .sort((a, b) => a.queuedAt!.localeCompare(b.queuedAt!) || a.id.localeCompare(b.id))
        .map((item) => item.id);
    }
    return this.queued;
  }

  /** 1 for the next to start; null when not queued. */
  queuePosition(id: string): number | null {
    const at = this.queue().indexOf(id);
    return at < 0 ? null : at + 1;
  }

  /** Some dependency is not yet `settled`. */
  private waiting(item: WorkItem): boolean {
    return item.dependsOn.some((id) => {
      const dependency = this.byId.get(id);
      return !dependency || !this.settled(dependency);
    });
  }

  settled(item: WorkItem): boolean {
    return item.state === "closed" || this.status(item) === "done";
  }

  /** Reachable only for work finished before `checkStart` refused it, or by a dependency added after. */
  finishedEarly(item: WorkItem): boolean {
    return this.status(item) === "done" && this.waiting(item);
  }

  /**
   * The stored status until the item has children, then `derive` over its open
   * ones, whatever the parent stores.
   */
  status(item: WorkItem): Status {
    if (!this.derived(item).includes("status")) return item.status;
    const cached = this.derivedStatus.get(item.id);
    if (cached) return cached;
    // Racing writes can store a parent cycle that validate would refuse; the
    // placeholder ends the recursion there instead of overflowing the stack.
    this.derivedStatus.set(item.id, item.status);
    const open = this.childrenOf(item.id)
      .map((id) => this.byId.get(id)!)
      .filter((child) => child.state === "open")
      .map((child) => this.status(child));
    const status = derive(open);
    this.derivedStatus.set(item.id, status);
    return status;
  }

  /** Which of `item`'s settable fields `view` computes rather than reads back. */
  derived(item: WorkItem): Derivable[] {
    return this.childrenOf(item.id).length ? ["status"] : [];
  }

  view(item: WorkItem): WorkItemView {
    return {
      ...item.toJSON(),
      shortId: this.shortId(item.id),
      status: this.status(item),
      heldBy: this.derived(item).includes("status") ? null : item.heldBy,
      children: this.childrenOf(item.id),
      blockedBy: this.blockedBy(item),
      finishedEarly: this.finishedEarly(item),
      queuePosition: this.queuePosition(item.id),
    };
  }

  views(): WorkItemView[] {
    return [...this.byId.values()].map((item) => this.view(item));
  }

  /** Throws GraphError if `candidate` cannot join the set, replacing `current` if given. */
  validate(candidate: WorkItem, current: WorkItem | null = null): void {
    this.checkParent(candidate);
    this.checkDependencies(candidate);
    this.checkSiblings(candidate, current);
  }

  /**
   * Dependencies are between siblings: same type, same parent. Only what a
   * write adds is checked, so an item keeps any older dependency it holds; a
   * move is refused while it would leave the item, or an open item depending
   * on it, depending on a non-sibling.
   */
  private checkSiblings(item: WorkItem, current: WorkItem | null): void {
    const sibling = (other: WorkItem) => other.type === item.type && other.parent === item.parent;
    const name = (other: WorkItem) => `${this.shortId(other.id)} ${other.type} "${other.title}"`;
    const moved = current !== null && (current.parent !== item.parent || current.type !== item.type);
    const added = item.dependsOn
      .filter((id) => moved || !current?.dependsOn.includes(id))
      .map((id) => this.byId.get(id)!)
      .filter((other) => !sibling(other));
    if (added.length && !moved) {
      throw new GraphError(
        `an item depends only on items of its own type with the same parent, which ${added.map(name).join(", ")} ` +
          `${added.length > 1 ? "are" : "is"} not: make the nearest items above them that are siblings depend on each other instead`,
      );
    }
    if (!moved) return;
    const dependents = [...this.byId.values()].filter(
      (other) => other.id !== item.id && other.state === "open" && other.dependsOn.includes(item.id) && !sibling(other),
    );
    if (added.length || dependents.length) {
      const parts = [
        ...(added.length ? [`it depends on ${added.map(name).join(", ")}`] : []),
        ...(dependents.length ? [`${dependents.map(name).join(", ")} depends on it`] : []),
      ];
      throw new GraphError(
        `an item cannot move to another parent while ${parts.join(" and ")}: dependencies are between siblings, so remove them first`,
      );
    }
  }

  /** Ids of the items, open or closed, carrying the tag `id`. */
  carrying(tag: string): string[] {
    return [...this.byId.values()].filter((item) => item.tags.includes(tag)).map((item) => item.id);
  }

  /** Ids that would break if `id` were removed. */
  referencesTo(id: string): string[] {
    return [...this.byId.values()]
      .filter((item) => item.parent === id || item.dependsOn.includes(id))
      .map((item) => item.id);
  }

  private checkParent(item: WorkItem): void {
    if (item.parent === item.id) throw new GraphError("an item cannot be its own parent");
    const parent = item.parent === null ? undefined : this.byId.get(item.parent);
    if (item.parent !== null && !parent) throw new GraphError(`no item with id ${item.parent}`);

    const needs = PARENT_TYPE[item.type];
    if (needs === null && parent) throw new GraphError(`${article(item.type)} has no parent`);
    if (needs !== null && parent?.type !== needs) {
      const given = parent ? `, not ${article(parent.type)}` : "";
      throw new GraphError(`${article(item.type)} needs ${article(needs)} as its parent${given}`);
    }

    // A re-typed parent must still be the type its children need. With that
    // and the above, every chain ends at an epic, so none can loop.
    for (const id of this.childrenOf(item.id)) {
      const child = this.byId.get(id)!;
      if (PARENT_TYPE[child.type] !== item.type) {
        throw new GraphError(
          `${article(item.type)} cannot hold ${article(child.type)}: ` +
            `${article(child.type)} needs ${article(PARENT_TYPE[child.type]!)} as its parent`,
        );
      }
    }
  }

  private checkDependencies(item: WorkItem): void {
    if (item.dependsOn.includes(item.id)) {
      throw new GraphError("an item cannot depend on itself");
    }
    for (const id of item.dependsOn) {
      if (!this.byId.get(id)) throw new GraphError(`no item with id ${id}`);
    }
    if (this.reaches(item.dependsOn, item.id, new Set())) {
      throw new GraphError("that dependency would create a cycle");
    }
  }

  /** Whether `target` is reachable by following dependsOn from any of `from`. */
  private reaches(from: string[], target: string, seen: Set<string>): boolean {
    for (const id of from) {
      if (id === target) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      const next = this.byId.get(id);
      if (next && this.reaches(next.dependsOn, target, seen)) return true;
    }
    return false;
  }
}

const article = (type: Type) => `${type === "epic" ? "an" : "a"} ${type}`;


/** First match wins. No open children counts as all of them done. */
function derive(children: Status[]): Status {
  if (children.every((status) => status === "done")) return "done";
  if (!children.some((status) => UNSTARTED.includes(status) || status === "in_progress")) {
    return "review";
  }
  if (!children.every((status) => UNSTARTED.includes(status))) return "in_progress";
  if (children.every((status) => status === "ready")) return "ready";
  return "backlog";
}
