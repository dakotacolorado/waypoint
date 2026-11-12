import { createRoute, z } from "@hono/zod-openapi";
import {
  ACTIONS,
  CLOSED_REASONS,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_TAGS,
  RECORDED,
  STATES,
  STATUSES,
  TYPES,
} from "./domain.ts";

/** Validates every request and generates `openapi.json`, so neither can drift. */

const Status = z.enum(STATUSES).openapi({ example: "ready" });
const State = z.enum(STATES).openapi({ example: "open" });
const ClosedReason = z.enum(CLOSED_REASONS).openapi({ example: "completed" });
const Type = z.enum(TYPES).openapi({ example: "task" });
const Id = z.string().uuid();
/** Resolved by `Graph.resolve`; stored as the full id. */
const Ref = z
  .string()
  .regex(/^[0-9a-fA-F-]{8,36}$/, "must be an item's id, or at least its first 8 characters")
  .describe("An item's id, or a prefix of it at least 8 characters long, such as its `shortId`.");
const Title = z.string().trim().min(1).max(200);
const Body = z.string().max(20_000);
const Criteria = z.array(z.string().trim().min(1)).max(50);
const DependsOn = z.array(Ref).max(50);
/** Refused rather than stripped, so a caller sending `tags` learns where they are written. */
const NotTags = z
  .unknown()
  .refine((tags) => tags === undefined, "tags are not set here: add or remove one at a time with POST and DELETE /items/{id}/tags")
  .describe("Not accepted: refused with 400 whatever its value. See `WorkItem.tags`.")
  .optional();
const StatusInput = Status.describe(
  "Read back as given until the item has children. On a parent it is stored but has no " +
    "effect while the parent has children, `done` included: a parent reads `done` by itself " +
    "once every open child does, so there is nothing to sign off. Never changes a child. " +
    "`in_progress`, `review` or `done` on a parent still reading `backlog` or `ready` is its " +
    "Start: refused with 409 while its `blockedBy`, its children's blockers included, is not empty.",
);

export const TickSchema = z
  .object({
    criterion: z.string().describe("The criterion's text, as it stood when ticked."),
    by: z
      .string()
      .nullable()
      .describe("The `claimed-by` of the write that ticked it, unverified; null when it said nothing."),
    at: z.string().describe("When it was ticked."),
  })
  .openapi("Tick");

export const AssignmentSchema = z
  .object({
    id: Id.describe("Drawn when the assignment is made; a new start on the item makes a new one."),
    agent: Id.nullable().describe(
      "The agent's id in worker-service, written once worker-service has made it, or for the queue's start once it has recorded the request, whose id its agent takes; null while it is being made.",
    ),
    name: z
      .string()
      .describe(
        "The agent's name, `<shortId>-<first 8 characters of id>`, or for the queue's start, once its request is recorded, `implementer-<first 8 characters of agent>`: who holds the item, and how a retry finds the agent already made.",
      )
      .openapi({ example: "6ff632ff-1c9e4a07" }),
    by: z
      .string()
      .nullable()
      .describe("The `claimed-by` of the request that made it, unverified; null when it said nothing, as the person's from the page."),
    at: z.string().describe("When it was made."),
    ended: z
      .object({
        at: z.string().describe("When it ended."),
        why: z.string().describe("Why, as the service says it: the item closed, or its agent retired."),
      })
      .nullable()
      .describe(
        "Null while the assignment stands. Set when the item is closed, or an item above it closes it, and kept on reopening: " +
          "an ended assignment holds nothing, and the next start makes a new one without asking worker-service.",
      ),
  })
  .openapi("Assignment");

/** The stored fields. */
export const WorkItemSchema = z
  .object({
    id: Id,
    type: Type,
    title: z.string(),
    body: z.string(),
    acceptanceCriteria: z.array(z.string()),
    met: z
      .array(TickSchema)
      .describe(
        "The acceptance criteria a reviewer has ticked as met, in the order of " +
          "`acceptanceCriteria`. Ticked and unticked one at a time by POST and DELETE " +
          "`/items/{id}/met`, or all at once by a patch's `met`; a tick goes when its criterion's text " +
          "changes or the criterion is dropped, so an edited criterion is met again only once " +
          "ticked again.",
      ),
    status: Status,
    state: State.describe(
      "Whether anyone still needs to see the item, apart from where the work got to: " +
        "`status` is never changed by closing, and reaching `done` does not close. " +
        "Every item is created `open`. Closing an item closes what is open beneath it; reopening writes no other item.",
    ),
    closedReason: ClosedReason.nullable().describe(
      "Why a closed item closed: `completed`, or `not_planned` for work abandoned at " +
        "any status. Null while open.",
    ),
    parent: Id.nullable().describe(
      "Required, and exactly one level up: a task's is a story, a story's is an epic. An " +
        "epic's is null. A create, move or re-type that breaks this is refused with 400.",
    ),
    dependsOn: z
      .array(Id)
      .describe(
        "Items that must read `done`, or be closed, before this one moves to `in_progress`, " +
          "`review` or `done`: see `blockedBy`. A dependency added to work already started " +
          "holds up only its next move. Only between siblings: each one added must be of the " +
          "item's own type with its parent, or the write is refused with 400 naming it; one " +
          "stored before that rule is kept. A move to another parent is refused with 400 while " +
          "it would leave the item, or an open item depending on it, depending on a non-sibling.",
      ),
    createdAt: z.string(),
    updatedAt: z.string(),
    heldBy: z
      .string()
      .nullable()
      .describe(
        "Who is on the item: the `claimed-by` of the write that last moved its stored " +
          "`status` to `in_progress`, unverified like a history entry's `claimedBy`, and null " +
          "if that write said nothing. Set by the service only. Kept through `review`; cleared " +
          "by a move to `backlog`, `ready` or `done`, or by closing, and set again only by a " +
          "later move to `in_progress`, so reopening alone leaves it null. A write that leaves " +
          "`status` as it was leaves it as it was. Null while `status` is derived.",
      ),
    reviewedBy: z
      .string()
      .nullable()
      .describe(
        "The reviewer that last picked the item up for review, as approval-service's reviewer " +
          "`reviewer-<id>`: written only by a write's `reviewedBy`, unverified like `heldBy`. " +
          "Null until one is written. Kept through every move and closing, and replaced by the " +
          "next review's write, so after a send-back it names the last reviewer until a new one picks it up.",
      ),
    queuedAt: z
      .string()
      .nullable()
      .describe(
        "When the item was queued to start on its own, by a write's `queued`; null when it is not " +
          "queued. Cleared in the same write that closes the item, moves its stored `status` to " +
          "`in_progress`, `review` or `done`. Queuing it again keeps the time.",
      ),
    tags: z
      .array(Id)
      .max(MAX_TAGS)
      .describe(
        `The ids of the tags the item carries, at most ${MAX_TAGS}, oldest added first: see \`/tags\`. ` +
          "Added and removed one at a time by `POST /items/{id}/tags` and `DELETE /items/{id}/tags/{tag}`, " +
          "never by `POST /items` or `PATCH`, so two writers tagging one item never overwrite each other. " +
          "Each is added to or removed from every item beneath, too. An item made under a parent, or " +
          "moved under one with everything beneath it, takes on the parent's tags besides its own, each " +
          `change in its history; moving away takes none off. A move giving any item a ${MAX_TAGS + 1}st is refused with 400 naming it.`,
      ),
    assignment: AssignmentSchema.nullable().describe(
      "The agent last started on the item, by `POST /items/{id}/assignment`, kept after it finishes; null when none ever was. " +
        "Written by that route alone, so it is the record of who works on the item, whatever its status.",
    ),
  })
  .openapi("WorkItem");

const FieldValue = z.union([z.string(), z.array(z.string()), z.boolean(), AssignmentSchema, z.null()]);

export const ChangeSchema = z
  .object({
    field: z.enum(RECORDED).describe("`met` is recorded as the texts of the criteria ticked."),
    from: FieldValue.describe("Null on `created`."),
    to: FieldValue.describe("Null on `deleted`."),
  })
  .openapi("Change");

export const HistoryEntrySchema = z
  .object({
    item: Id.describe(
      "The item written: this one, or one beneath it when the write was made.",
    ),
    action: z.enum(ACTIONS).openapi({ example: "updated" }),
    changes: z
      .array(ChangeSchema)
      .describe(
        "Each stored field whose value differs, as the item stood before and after. Empty " +
          "when an update set every field to what it already held.",
      ),
    at: z.string().describe("When the service recorded it."),
    claimedBy: z
      .string()
      .nullable()
      .describe(
        "The `claimed-by` header the write was sent with, unverified: callers sharing a token " +
          "say who they are by it. Without one, the name of the write's token; null for an admin token's write that said nothing, the person's.",
      ),
    overrode: z
      .array(Id)
      .describe(
        "The dependencies a `force` moved the item past, unfinished as the write found them: an " +
          "override, made by the person since only a write with no `claimed-by` may force. Empty otherwise.",
      ),
  })
  .openapi("HistoryEntry");

/** What a read returns: the stored fields plus what the set implies. */
export const WorkItemViewSchema = WorkItemSchema.extend({
  shortId: z
    .string()
    .describe(
      "The shortest prefix of `id`, at least 8 characters, that starts no other item's id: " +
        "what people and workers call the item. Every route taking an item's id takes this " +
        "too. A new item's id is drawn so its first 8 characters start no other's, so a " +
        "`shortId` once read back never comes to name a second item.",
    )
    .openapi({ example: "6ff632ff" }),
  status: Status.describe(
    "Stored on an item without children. On a parent it is derived from its open children's " +
      "statuses alone, by the first of these that holds: (1) every child `done` gives " +
      "`done`; (2) no child `backlog`, `ready` or " +
      "`in_progress` gives `review`; (3) any child `in_progress`, `review` or `done` gives " +
      "`in_progress`; (4) every child `ready` gives `ready`; (5) otherwise `backlog`. A parent " +
      "whose children are all closed counts them as all `done`. So finished work beside " +
      "unstarted work reads `in_progress`, a parent reads `review` only when nothing beneath " +
      "it is unstarted or in progress, and `done` once everything beneath it is, with no write " +
      "to it; it reads `in_progress` or `review` again as soon as a child does. An item left " +
      "without children reads its stored status.",
  ),
  children: z.array(Id).describe("Items whose parent is this one."),
  blockedBy: z
    .array(Id)
    .describe(
      "At every status, each dependency of this item, of any item above it, or of any open item " +
        "below it not yet `done`, that is open and does not read `done`, or is no longer known. " +
        "A dependency of an item below on this item or another below it is left out: that is " +
        "work this one does. So a parent reads blocked for the same reasons its children do. " +
        "A closed one, whatever its `closedReason` " +
        "or `status`, does not hold anything up until it is reopened; one in `review` still " +
        "does. While it is not empty, a move to `in_progress`, `review` or `done`, or under a " +
        "new parent at one of those, is refused with 409.",
    ),
  finishedEarly: z
    .boolean()
    .describe(
      "`done` while some dependency of its own is neither `done` nor closed: work finished " +
        "before dependencies gated the move, or given a dependency once done. Derived on read " +
        "and never stored, so it clears once every dependency is `done` or closed, or the " +
        "item leaves `done`.",
    ),
  queuePosition: z
    .int()
    .positive()
    .nullable()
    .describe(
      "The item's place in the queue, 1 for the next to start, counting the open items with a " +
        "`queuedAt` whose `status` reads `backlog` or `ready`, in the order queued; null when not " +
        "among them. A parent queued while its children read as started is left out until they do " +
        "not. Derived on read, so it moves up as soon as an item ahead is dequeued, closed or started.",
    ),
}).openapi("WorkItemView");

export const AgentOutcomeSchema = z
  .object({
    id: Id.describe("The agent's id in worker-service, from the assignment."),
    name: z.string(),
    outcome: z.enum(["retired", "already_retired", "refused"]).describe(
      "`retired`: worker-service retired it now. `already_retired`: it was retired, or worker-service has no record of it, so nothing was retired. `refused`: worker-service would not retire it, in `said`.",
    ),
    said: z.string().describe("The outcome in a line for the person, with worker-service's words when it refused."),
  })
  .openapi("AgentOutcome");

export const DraftSchema = z
  .object({
    type: Type.default("task"),
    title: Title,
    body: Body.default(""),
    acceptanceCriteria: Criteria.default([]).describe("One line per criterion."),
    status: StatusInput.default("backlog"),
    parent: Ref.nullable()
      .default(null)
      .describe("A story for a task, an epic for a story, null only for an epic."),
    dependsOn: DependsOn.default([]),
    tags: NotTags,
  })
  .openapi("Draft");

export const PatchSchema = z
  .object({
    type: Type,
    title: Title,
    body: Body,
    acceptanceCriteria: Criteria,
    met: z
      .array(z.string())
      .max(50)
      .describe(
        "Every criterion now met, by its text: replaces every tick held, so a tick another " +
          "writer made since this one read the item is lost. To tick or untick one criterion, " +
          "use POST or DELETE `/items/{id}/met`. One already ticked " +
          "keeps who ticked it and when; one newly named is ticked by this write's " +
          "`claimed-by`, now. Each must be one of the item's `acceptanceCriteria` as this " +
          "write leaves them, or the write is refused with 400.",
      ),
    status: StatusInput,
    state: State.describe(
      "Closing closes everything still open beneath the item, for the same reason; reopening opens only the item, keeping its status. " +
        "Closing an epic that has children as `completed` is the person's sign-off: refused with 403 from a write that sends `claimed-by`.",
    ),
    closedReason: ClosedReason.describe("Required with, and only with, `state: closed`."),
    parent: Ref.nullable(),
    dependsOn: DependsOn,
    reviewedBy: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .nullable()
      .describe("The worker reviewing the item, as the reviewer's own name; null clears it."),
    force: z
      .literal(true)
      .describe(
        "Move the item to `in_progress`, `review` or `done` though its `blockedBy` is not empty, " +
          "recorded as the history entry's `overrode`. The person's alone: refused with 403 from a " +
          "write that sends `claimed-by`, as every worker's does. Changes nothing on its own.",
      ),
    queued: z
      .boolean()
      .describe(
        "`true` queues the item to start on its own, at the back of the queue, or keeps its place " +
          "if already queued; `false` takes it off. Only an open epic, story or task that reads " +
          "`backlog` or `ready` can be queued, as this write leaves it: any other is refused with 400, " +
          "naming why. Recorded in `history` as a change to `queuedAt`.",
      ),
    tags: NotTags,
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, { message: "no updatable fields supplied" })
  .refine((patch) => (patch.state === "closed") === (patch.closedReason !== undefined), {
    message: "closedReason is required with, and only with, state: closed",
    path: ["closedReason"],
  })
  .openapi("Patch");

const Author = z
  .string()
  .nullable()
  .describe(
    "The `claimed-by` header it was written with, unverified, as a history entry's `claimedBy`. " +
      "Null when the writer said nothing, as a person writing from the page does.",
  );
const NoteBody = z.string().trim().min(1).max(20_000).describe("Markdown.");

export const CommentSchema = z
  .object({
    id: Id,
    item: Id.describe("The item it was written on."),
    author: Author,
    at: z.string().describe("When the service recorded it."),
    body: NoteBody,
  })
  .openapi("Comment");

export const WorkLogEntrySchema = CommentSchema.extend({
  links: z.array(z.string()).describe("Pull requests, commits or anything else the work left behind."),
}).openapi("WorkLogEntry");

export const CommentDraftSchema = z.object({ body: NoteBody }).openapi("CommentDraft");

export const WorkLogDraftSchema = z
  .object({
    body: NoteBody.describe("What was done, in Markdown."),
    links: z
      .array(z.string().url().max(2_000).refine((url) => /^https?:\/\//i.test(url), "must be http or https"))
      .max(20)
      .default([]),
  })
  .openapi("WorkLogDraft");

const ErrorSchema = z.object({ error: z.string() }).openapi("Error");

const BlockedSchema = ErrorSchema.extend({
  blockedBy: z
    .array(Id)
    .describe("The item's `blockedBy`: each dependency to wait for, named with its title and status in `error`."),
}).openapi("Blocked");

const ConflictSchema = ErrorSchema.extend({
  matches: z
    .array(Id)
    .optional()
    .describe("When an id was given as a prefix that more than one item's id starts with: those items."),
}).openapi("Conflict");

const IdParam = z.object({
  id: z
    .string()
    .describe("The item's id, or a prefix of it at least 8 characters long, such as its `shortId`.")
    .openapi({ param: { name: "id", in: "path" } }),
});

/** Hono reads headers lower-cased, so the key must be too. */
export const ClaimHeader = z.object({
  "claimed-by": Title.optional().describe(
    "Who is making the write, recorded in its history entry as said and not checked. Absent, the write is its token's: " +
      "an admin token's is the person's, which alone may sign off an epic, force a move or set the queue's limit.",
  ),
});

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { "application/json": { schema } },
});

const FAILS = {
  400: json(ErrorSchema, "The request failed validation, or breaks the item graph."),
  401: json(ErrorSchema, "Missing or incorrect bearer token."),
};
const AMBIGUOUS = json(ConflictSchema, "An id was given as a prefix that more than one item's id starts with.");
const FAILS_OR_MISSING = {
  ...FAILS,
  404: json(ErrorSchema, "No item with that id."),
  409: AMBIGUOUS,
};
const secured = { security: [{ bearerAuth: [] }], tags: ["items"] };

// --- routes -----------------------------------------------------------------

export const healthRoute = createRoute({
  method: "get",
  path: "/health",
  operationId: "healthCheck",
  tags: ["meta"],
  summary: "Liveness check",
  responses: {
    200: json(
      z.object({
        ok: z.literal(true),
        version: z.string().describe("The package's version."),
        commit: z.string().describe("The commit this copy was built from: 40 hex characters, `-dirty` when its tree differed, or `unknown`."),
      }),
      "Service is up.",
    ),
  },
});

export const listRoute = createRoute({
  ...secured,
  method: "get",
  path: "/items",
  operationId: "listItems",
  summary: "List items",
  description:
    "Filters combine by AND. What can be started now is the `ready` items whose " +
    "`blockedBy` is empty; any other is refused until it is.",
  request: {
    query: z.object({
      status: Status.optional(),
      state: State.optional().describe("`open` for only what still needs looking at."),
      type: Type.optional(),
      parent: Ref.optional().describe("Only the children of this item, by its id or a prefix of it."),
      heldBy: z
        .string()
        .optional()
        .describe("Only items whose `heldBy` is exactly this, as `heldBy=agent-1&state=open`."),
      reviewedBy: z
        .string()
        .optional()
        .describe("Only items whose `reviewedBy` is exactly this."),
      queued: z
        .enum(["true", "false"])
        .optional()
        .describe(
          "`true` for only the queue, listed in its order, next to start first; `false` for only " +
            "what is not in it. See `WorkItemView.queuePosition`.",
        ),
      tag: z
        .string()
        .optional()
        .describe(
          "Only items carrying this tag, by its id or its value in any case, as `tag=ui&state=open`. " +
            "A tag that does not exist gives an empty list.",
        ),
    }),
  },
  responses: {
    200: json(z.object({ items: z.array(WorkItemViewSchema) }), "The matching items."),
    ...FAILS,
  },
});

export const createItemRoute = createRoute({
  ...secured,
  method: "post",
  path: "/items",
  operationId: "createItem",
  summary: "Create an item",
  request: { headers: ClaimHeader, body: json(DraftSchema, "The item to create.") },
  responses: {
    201: json(WorkItemViewSchema, "The created item."),
    ...FAILS,
    409: json(
      z.union([ConflictSchema, BlockedSchema]),
      "Created at `in_progress`, `review` or `done` with a dependency not yet `done` or closed; other writes kept landing first, so retry; or an id was given as a prefix that more than one item's id starts with.",
    ),
  },
});

export const getRoute = createRoute({
  ...secured,
  method: "get",
  path: "/items/{id}",
  operationId: "getItem",
  summary: "Read one item",
  request: { params: IdParam },
  responses: { 200: json(WorkItemViewSchema, "The item."), ...FAILS_OR_MISSING },
});

export const patchRoute = createRoute({
  ...secured,
  method: "patch",
  path: "/items/{id}",
  operationId: "updateItem",
  summary: "Update the fields supplied, leaving the rest alone",
  description:
    "Setting `done` on a parent whose open children are not all `done` is refused with 400. " +
    "Moving an item to `in_progress`, `review` or `done`, or under a new parent while there, " +
    "is refused with 409 while its `blockedBy` is not empty, unless the person sends `force`. " +
    "A parent's status follows its children's, whatever is written to it, but writing it " +
    "`in_progress`, `review` or `done` while it reads `backlog` or `ready` is its Start, " +
    "refused the same way.",
  request: { params: IdParam, headers: ClaimHeader, body: json(PatchSchema, "Fields to change.") },
  responses: {
    200: json(
      WorkItemViewSchema.extend({
        agent: AgentOutcomeSchema.optional().describe(
          "Present only on the person's sign-off of an epic (closing it `completed`) whose assignment names an agent: what was done to that agent. The close stands whatever it says.",
        ),
      }).openapi("UpdatedItem"),
      "The updated item.",
    ),
    ...FAILS_OR_MISSING,
    403: json(
      ErrorSchema,
      "Sent with a `claimed-by`, a `force`, or closing an epic that has children as `completed`: only the person may override `blockedBy` or sign off an epic.",
    ),
    409: json(
      z.union([ConflictSchema, BlockedSchema]),
      "A dependency is not yet `done` or closed; other writes kept landing first, so retry; or an id was given as a prefix that more than one item's id starts with.",
    ),
  },
});

export const deleteRoute = createRoute({
  ...secured,
  method: "delete",
  path: "/items/{id}",
  operationId: "deleteItem",
  summary: "Delete an item",
  description:
    "Refused while another item names it as a parent or a dependency. The item's history " +
    "outlives it.",
  request: { params: IdParam, headers: ClaimHeader },
  responses: {
    204: { description: "Deleted, or already absent, which records nothing." },
    409: json(
      ConflictSchema,
      "Another item still references it, other writes kept landing first, or the id was given as a prefix that more than one item's id starts with.",
    ),
    ...FAILS,
  },
});

export const historyRoute = createRoute({
  ...secured,
  method: "get",
  path: "/items/{id}/history",
  operationId: "getItemHistory",
  summary: "Read every write to an item and to everything beneath it",
  description:
    "One entry per create, update and delete, recorded by the service in the same " +
    "transaction as the write, under the item written and every item above it at the time; " +
    "a move files it under both sides. A write beneath an item is how a derived `status` " +
    "changes, so that change has no entry of its own. No operation edits or removes an entry, " +
    "and deleting an item leaves its history readable here.",
  request: { params: IdParam },
  responses: {
    200: json(
      z.object({ entries: z.array(HistoryEntrySchema).describe("Oldest first.") }),
      "The item's history.",
    ),
    ...FAILS,
    404: json(ErrorSchema, "No item with that id, and none ever recorded."),
    409: AMBIGUOUS,
  },
});

const TagRef = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .describe("A tag's id, or its value in any case.")
  .openapi({ example: "ui" });

const TaggedViewSchema = WorkItemViewSchema.extend({
  reached: z.number().int().min(0).describe("How many items beneath this one the write changed."),
}).openapi("TaggedItemView");

export const tagItemRoute = createRoute({
  ...secured,
  method: "post",
  path: "/items/{id}/tags",
  operationId: "addItemTag",
  summary: "Add a tag to an item",
  description:
    "Adds one tag to `tags` on the item and on every item beneath it, open or closed, in one write. " +
    "Each item it changes records its own `tags` change in `history`; one already carrying the tag " +
    "is left alone and records nothing. Refused with 400, changing nothing, for a tag that does not exist, " +
    `or for one past the ${MAX_TAGS} an item may carry on any item it reaches, naming those.`,
  request: {
    params: IdParam,
    headers: ClaimHeader,
    body: json(z.object({ tag: TagRef }).openapi("ItemTag"), "The tag to add."),
  },
  responses: {
    200: json(TaggedViewSchema, "The item, carrying the tag."),
    ...FAILS_OR_MISSING,
    409: json(ConflictSchema, "Other writes kept landing first, so retry; or an id was given as a prefix that more than one item's id starts with."),
  },
});

export const untagItemRoute = createRoute({
  ...secured,
  method: "delete",
  path: "/items/{id}/tags/{tag}",
  operationId: "removeItemTag",
  summary: "Take a tag off an item",
  description:
    "Removes one tag from `tags` on the item and on every item beneath it, open or closed, in one write, " +
    "each item it changes recording its own `tags` change in `history`. Items not carrying it, or a tag " +
    "that does not exist, are left alone and record nothing. Taken off a child alone, its parent and " +
    "siblings keep it.",
  request: {
    params: IdParam.extend({ tag: TagRef.openapi({ param: { name: "tag", in: "path" } }) }),
    headers: ClaimHeader,
  },
  responses: {
    200: json(TaggedViewSchema, "The item, without the tag."),
    ...FAILS_OR_MISSING,
    409: json(ConflictSchema, "Other writes kept landing first, so retry; or an id was given as a prefix that more than one item's id starts with."),
  },
});

const Criterion = z
  .object({ criterion: z.string().trim().min(1).describe("The criterion's text, exactly as in `acceptanceCriteria`.") })
  .openapi("Criterion");

const TICK_RESPONSES = {
  ...FAILS_OR_MISSING,
  400: json(ErrorSchema, "The request failed validation, or the item has no criterion with that text, named."),
  409: json(ConflictSchema, "Other writes kept landing first, so retry; or an id was given as a prefix that more than one item's id starts with."),
};

export const tickRoute = createRoute({
  ...secured,
  method: "post",
  path: "/items/{id}/met",
  operationId: "tickCriterion",
  summary: "Tick one acceptance criterion as met",
  description:
    "Adds one tick to `met`, by the criterion's text, recording this write's `claimed-by` and now; " +
    "every other tick stays as it stands when the write lands, so two writers ticking different " +
    "criteria at once both keep theirs. One already ticked changes nothing and records no history; " +
    "otherwise `history` records it as a `met` change. Refused with 400 for a criterion the item does not have.",
  request: {
    params: IdParam,
    headers: ClaimHeader,
    body: json(Criterion, "The criterion to tick."),
  },
  responses: { 200: json(WorkItemViewSchema, "The item, with the criterion ticked."), ...TICK_RESPONSES },
});

export const untickRoute = createRoute({
  ...secured,
  method: "delete",
  path: "/items/{id}/met",
  operationId: "untickCriterion",
  summary: "Untick one acceptance criterion",
  description:
    "Removes that criterion's tick from `met`, leaving every other. One not ticked changes nothing " +
    "and records no history. Refused with 400 for a criterion the item does not have.",
  request: {
    params: IdParam,
    headers: ClaimHeader,
    body: json(Criterion, "The criterion to untick."),
  },
  responses: { 200: json(WorkItemViewSchema, "The item, without the criterion's tick."), ...TICK_RESPONSES },
});

const SkillFileSchema = z.object({
  path: z.string().describe("Under the worker's Claude Code folder: `skills/work-tracker/bin/…` or `skills/work-tracker/reference/…`."),
  content: z.string(),
  executable: z.boolean(),
});

export const SkillSchema = z
  .object({
    key: z.string().describe("The skill's name, which its files are under."),
    version: z.int().describe("The deployed tree's commit count, 0 when deployed from outside git."),
    commit: z.string().describe("The deployed commit, ending `-dirty` when deployed with uncommitted changes."),
    files: z.array(SkillFileSchema),
  })
  .openapi("Skill");

export const skillRoute = createRoute({
  security: [{ bearerAuth: [] }],
  tags: ["meta"],
  method: "get",
  path: "/skill",
  operationId: "getSkill",
  summary: "Read the client workers call this deployment with",
  description:
    "The work-tracker skill's `bin/` and `reference/`, as this deployment was built with them, " +
    "so a worker calls the API that is deployed. Its `SKILL.md` is not here: guidance stays in " +
    "document-service's `global`.",
  responses: {
    200: json(SkillSchema, "The skill's files."),
    401: FAILS[401],
  },
});
const NOTES =
  "Written by any caller and edited by none, apart from the item's fields and their " +
  "`history`. Writing one changes nothing on the item and records no history entry.";

export const commentsRoute = createRoute({
  ...secured,
  method: "get",
  path: "/items/{id}/comments",
  operationId: "listItemComments",
  summary: "Read the comments on an item",
  description: `What people and workers said to each other about the item, not beneath it. ${NOTES}`,
  request: { params: IdParam },
  responses: {
    200: json(z.object({ comments: z.array(CommentSchema).describe("Oldest first.") }), "The item's comments."),
    ...FAILS_OR_MISSING,
  },
});

export const commentRoute = createRoute({
  ...secured,
  method: "post",
  path: "/items/{id}/comments",
  operationId: "addItemComment",
  summary: "Comment on an item",
  request: { params: IdParam, headers: ClaimHeader, body: json(CommentDraftSchema, "The comment.") },
  responses: { 201: json(CommentSchema, "The comment, as stored."), ...FAILS_OR_MISSING },
});

export const workLogRoute = createRoute({
  ...secured,
  method: "get",
  path: "/items/{id}/work-log",
  operationId: "listItemWorkLog",
  summary: "Read what was done on an item",
  description: `A worker's record of each step it finished on the item, kept apart from comments. ${NOTES}`,
  request: { params: IdParam },
  responses: {
    200: json(z.object({ entries: z.array(WorkLogEntrySchema).describe("Oldest first.") }), "The item's work log."),
    ...FAILS_OR_MISSING,
  },
});

export const workLogEntryRoute = createRoute({
  ...secured,
  method: "post",
  path: "/items/{id}/work-log",
  operationId: "addItemWorkLogEntry",
  summary: "Record a step done on an item",
  request: { params: IdParam, headers: ClaimHeader, body: json(WorkLogDraftSchema, "What was done.") },
  responses: { 201: json(WorkLogEntrySchema, "The entry, as stored."), ...FAILS_OR_MISSING },
});

// --- assignment -------------------------------------------------------------

const AssignedSchema = ErrorSchema.extend({
  assignment: AssignmentSchema.describe("The item's assignment, whose agent still holds it: open its chat rather than start another."),
}).openapi("Assigned");

export const assignRoute = createRoute({
  ...secured,
  method: "post",
  path: "/items/{id}/assignment",
  operationId: "assignItem",
  summary: "Start an agent on an item",
  description:
    "The one way to start work on an item. In one write it records a new `assignment`, refused with 409 while the item's " +
    "current one names an agent still live: not retired, and not stopped after saying `done`. On an item whose status is its own " +
    "that write also moves it to `in_progress` held by the assignment's `name`, so it is refused with 409 as a move is while " +
    "`blockedBy` is not empty; a parent not yet reading started is refused the same, as its Start. The item and everything " +
    "beneath it leave the queue. Then worker-service makes the agent, " +
    "named `name`, briefed with the item, labelled `ticket: <title>`, given the `tickets` document and stopped once it says " +
    "`done`; its id is written to `assignment.agent`. A name already taken is the same agent made by an earlier try, and is " +
    "taken as made. If worker-service makes none, the item is put back as it was and the refusal is answered with 502 in " +
    "worker-service's words. A closed item is refused with 400.",
  request: { params: IdParam, headers: ClaimHeader },
  responses: {
    201: json(WorkItemViewSchema, "The item, its `assignment` naming the agent made."),
    ...FAILS_OR_MISSING,
    409: json(
      z.union([AssignedSchema, BlockedSchema, ConflictSchema]),
      "An agent still holds the item, named in `assignment`, or is still being made; a dependency is not yet `done` or closed; " +
        "other writes kept landing first, so retry; or an id was given as a prefix that more than one item's id starts with.",
    ),
    502: json(ErrorSchema, "worker-service made no agent, in its words; the item is as it was."),
    503: json(ErrorSchema, "No address or token for worker-service is configured."),
  },
});

// --- tags -------------------------------------------------------------------

const TagValue = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .describe("The text shown on the chip. Unique among tags case-insensitively.")
  .openapi({ example: "ui" });
const TagColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "must be a #rrggbb hex colour")
  .describe("The chip's background, `#rrggbb`, stored as given.")
  .openapi({ example: "#3b82f6" });
const TagDescription = z.string().trim().max(500).describe("What the tag is for, shown when hovering its chip.");

export const TagSchema = z
  .object({
    id: Id,
    value: TagValue,
    color: TagColor,
    description: TagDescription,
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Tag");

export const TagDraftSchema = z
  .object({ value: TagValue, color: TagColor, description: TagDescription.default("") })
  .openapi("TagDraft");

export const TagPatchSchema = z
  .object({ value: TagValue, color: TagColor, description: TagDescription })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, { message: "no updatable fields supplied" })
  .openapi("TagPatch");

const TakenSchema = ErrorSchema.extend({
  tag: Id.describe("The tag that already has the value."),
}).openapi("TagTaken");

const TagIdParam = z.object({
  id: Id.describe("The tag's id.").openapi({ param: { name: "id", in: "path" } }),
});

const taggable = { security: [{ bearerAuth: [] }], tags: ["tags"] };
const TAKEN = json(
  z.union([TakenSchema, ErrorSchema]),
  "Another tag already has the value, case-insensitively; or other writes kept landing first, so retry.",
);
const NO_TAG = { 404: json(ErrorSchema, "No tag with that id.") };

export const listTagsRoute = createRoute({
  ...taggable,
  method: "get",
  path: "/tags",
  operationId: "listTags",
  summary: "List tags",
  responses: {
    200: json(z.object({ tags: z.array(TagSchema).describe("By value.") }), "Every tag."),
    ...FAILS,
  },
});

export const createTagRoute = createRoute({
  ...taggable,
  method: "post",
  path: "/tags",
  operationId: "createTag",
  summary: "Create a tag",
  request: { body: json(TagDraftSchema, "The tag to create.") },
  responses: { 201: json(TagSchema, "The created tag."), ...FAILS, 409: TAKEN },
});

export const getTagRoute = createRoute({
  ...taggable,
  method: "get",
  path: "/tags/{id}",
  operationId: "getTag",
  summary: "Read one tag",
  request: { params: TagIdParam },
  responses: { 200: json(TagSchema, "The tag."), ...FAILS, ...NO_TAG },
});

export const patchTagRoute = createRoute({
  ...taggable,
  method: "patch",
  path: "/tags/{id}",
  operationId: "updateTag",
  summary: "Update the tag's fields supplied, leaving the rest alone",
  request: { params: TagIdParam, body: json(TagPatchSchema, "Fields to change.") },
  responses: { 200: json(TagSchema, "The updated tag."), ...FAILS, ...NO_TAG, 409: TAKEN },
});

export const deleteTagRoute = createRoute({
  ...taggable,
  method: "delete",
  path: "/tags/{id}",
  operationId: "deleteTag",
  summary: "Delete a tag",
  description: "Refused with 409 while any item, open or closed, carries it: take it off them first.",
  request: { params: TagIdParam },
  responses: {
    204: { description: "Deleted, or already absent." },
    409: json(ErrorSchema, "Items still carry the tag, named by how many and the first few by short id; or other writes kept landing first, so retry."),
    ...FAILS,
  },
});

// --- queue ------------------------------------------------------------------

const AGENT_STATES = ["idle", "working", "waiting", "interrupted", "retired", "unknown"] as const;

export const QueueItemSchema = z
  .object({ id: Id, shortId: z.string(), title: z.string(), status: Status })
  .openapi("QueueItem");

export const RunningSchema = z
  .object({
    item: QueueItemSchema,
    agent: z
      .object({
        id: Id.describe("The agent's id in worker-service, which is its request's."),
        name: z.string().openapi({ example: "implementer-1c9e4a07" }),
        state: z
          .enum(AGENT_STATES)
          .describe("As worker-service last said; `unknown` when it could not be asked, which still holds the place."),
      })
      .describe("The agent the queue's request started."),
    startedAt: z.string().describe("When the queue requested it: its assignment's `at`."),
  })
  .openapi("QueueRunning");

export const QueuedSchema = z
  .object({
    item: QueueItemSchema,
    position: z.number().int().nullable().describe("Its `queuePosition`; null once `requested`, when it has left the queue's order."),
    state: z
      .enum(["next", "blocked", "requested"])
      .describe(
        "`next`: it starts, in `position` order, once a running place is free. `blocked`: it waits on `blockedBy` and keeps its place. " +
          "`requested`: the queue asked worker-service for its agent, and the request still waits to be admitted, holding a running place.",
      ),
    blockedBy: z.array(QueueItemSchema).describe("While `blocked`: each item it waits on, its own dependency or one above or below it."),
    request: z
      .object({
        id: Id,
        name: z.string().describe("The name its agent will have."),
        why: z.string().describe("Why it has not started, in worker-service's words."),
      })
      .nullable()
      .describe("While `requested`, once the request is recorded; null otherwise."),
  })
  .openapi("Queued");

export const LastRunSchema = z
  .object({
    at: z.string().describe("When the dispatcher's last run ended."),
    requested: z
      .array(
        z.object({
          item: Id,
          shortId: z.string(),
          request: Id,
          worker: z.string().describe("The name of the agent the request starts."),
          state: z.enum(["waiting", "started", "withdrawn"]),
          why: z.string().nullable().describe("While `waiting`, why, in worker-service's words."),
        }),
      )
      .describe("The requests it made, in queue order."),
    why: z.array(z.string()).describe("Why it requested nothing more: what held each place, or what stopped it."),
  })
  .openapi("LastRun");

export const QueueSchema = z
  .object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .describe(`How many queued items the dispatcher keeps running at once; ${DEFAULT_LIMIT} until the person sets it.`),
    running: z
      .array(RunningSchema)
      .describe(
        "Each item the queue started whose agent has started, oldest first. An item holds a running place, here or as `requested`, " +
          "until it reads `review` or `done` (an epic by its derived status), is closed, or its agent is retired; an agent waiting on a question keeps it.",
      ),
    queued: z
      .array(QueuedSchema)
      .describe("The requests still waiting to be admitted, oldest first, then every item still queued, in order."),
    last: LastRunSchema.nullable().describe("The dispatcher's last run; null before its first."),
  })
  .openapi("Queue");

const queueTagged = { security: [{ bearerAuth: [] }], tags: ["queue"] };

export const queueRoute = createRoute({
  ...queueTagged,
  method: "get",
  path: "/queue",
  operationId: "getQueue",
  summary: "The queue: its running limit, what runs, what waits and why, and the dispatcher's last run",
  description:
    "The dispatcher runs every 5 minutes: while fewer than `limit` running places are taken, it requests an implementer for " +
    "each `next` item in order. A queued epic is requested once, at the epic level, and what is queued beneath it leaves the queue. " +
    "A blocked item keeps its place. An agent's state is read from worker-service on each call.",
  responses: { 200: json(QueueSchema, "The queue."), ...FAILS },
});

export const QueuePatchSchema = z
  .object({ limit: z.number().int().min(1).max(MAX_LIMIT).describe(`From 1 to ${MAX_LIMIT}.`) })
  .strict()
  .openapi("QueuePatch");

export const patchQueueRoute = createRoute({
  ...queueTagged,
  method: "patch",
  path: "/queue",
  operationId: "updateQueue",
  summary: "Set the running limit: the person's write alone",
  description:
    "Raising it starts more on the dispatcher's next run, within 5 minutes. Lowering it stops nothing running: nothing new starts until fewer than it are.",
  request: { headers: ClaimHeader, body: json(QueuePatchSchema, "The new limit.") },
  responses: {
    200: json(QueueSchema, "The queue, at its new limit."),
    ...FAILS,
    403: json(ErrorSchema, "Sent with a `claimed-by`: only the person sets the running limit."),
  },
});
