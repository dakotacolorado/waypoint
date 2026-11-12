# waypoint API

Generated from this deployment's `openapi.json`. `bin/` adds the address, the bearer token and `claimed-by`, so a path is all a call needs. A field marked `?` is optional.

One entity, the work item, at exactly three levels: an epic has no parent, every story has an epic, and every task has a story. `status` values are the board columns. A parent's `status` is derived from its open children's, by the rule on `WorkItemView.status`. `state` is separate: `open` until the item is closed, as `completed` or `not_planned`, from any status. An item may depend on its siblings, items of its type with its parent, and lists in `blockedBy` each dependency, its own or an item's above or below it, not yet `done` or closed. The service refuses with 409 a move to `in_progress`, `review` or `done` while `blockedBy` is not empty, and refuses a parent of the wrong type, a dependency on a non-sibling, a cycle, or deleting an item still referenced. Every create, update and delete is recorded in the item's `history`, which no operation edits. Beside its fields an item keeps `comments`, what people and workers say about it, and a `work-log`, what was done on it; neither changes the item or its history. A story or task not yet started can be `queued` to start on its own, in the order queued, as many at once as the queue's running limit: see `WorkItemView.queuePosition` and `/queue`. Acceptance criteria are ticked and unticked one at a time at `/items/{id}/met`. Tags, at `/tags`, are a shared list of labels, each a unique value, a colour and a description; an item carries some in `tags`, added and removed one at a time at `/items/{id}/tags`, each on the item and everything beneath it.

## GET /items

List items.

Filters combine by AND. What can be started now is the `ready` items whose `blockedBy` is empty; any other is refused until it is.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `status`? | query | `backlog`, `ready`, `in_progress`, `review`, `done` |  |
| `state`? | query | `open`, `closed` | `open` for only what still needs looking at. |
| `type`? | query | `epic`, `story`, `task` |  |
| `parent`? | query | string | Only the children of this item, by its id or a prefix of it. |
| `heldBy`? | query | string | Only items whose `heldBy` is exactly this, as `heldBy=agent-1&state=open`. |
| `reviewedBy`? | query | string | Only items whose `reviewedBy` is exactly this. |
| `queued`? | query | `true`, `false` | `true` for only the queue, listed in its order, next to start first; `false` for only what is not in it. See `WorkItemView.queuePosition`. |
| `tag`? | query | string | Only items carrying this tag, by its id or its value in any case, as `tag=ui&state=open`. A tag that does not exist gives an empty list. |

- 200: The matching items. → {items: `WorkItemView`[]}
- 400: The request failed validation, or breaks the item graph. → `Error`
- 401: Missing or incorrect bearer token. → `Error`

## POST /items

Create an item.

Body: `Draft`. The item to create.

- 201: The created item. → `WorkItemView`
- 400: The request failed validation, or breaks the item graph. → `Error`
- 401: Missing or incorrect bearer token. → `Error`
- 409: Created at `in_progress`, `review` or `done` with a dependency not yet `done` or closed; other writes kept landing first, so retry; or an id was given as a prefix that more than one item's id starts with. → `Conflict` or `Blocked`

## GET /items/{id}

Read one item.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string | The item's id, or a prefix of it at least 8 characters long, such as its `shortId`. |

- 200: The item. → `WorkItemView`
- 400: The request failed validation, or breaks the item graph. → `Error`
- 401: Missing or incorrect bearer token. → `Error`
- 404: No item with that id. → `Error`
- 409: An id was given as a prefix that more than one item's id starts with. → `Conflict`

## PATCH /items/{id}

Update the fields supplied, leaving the rest alone.

Setting `done` on a parent whose open children are not all `done` is refused with 400. Moving an item to `in_progress`, `review` or `done`, or under a new parent while there, is refused with 409 while its `blockedBy` is not empty, unless the person sends `force`. A parent's status follows its children's, whatever is written to it, but writing it `in_progress`, `review` or `done` while it reads `backlog` or `ready` is its Start, refused the same way.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string | The item's id, or a prefix of it at least 8 characters long, such as its `shortId`. |

Body: `Patch`. Fields to change.

- 200: The updated item. → `UpdatedItem`
- 400: The request failed validation, or breaks the item graph. → `Error`
- 401: Missing or incorrect bearer token. → `Error`
- 403: Sent with a `claimed-by`, a `force`, or closing an epic that has children as `completed`: only the person may override `blockedBy` or sign off an epic. → `Error`
- 404: No item with that id. → `Error`
- 409: A dependency is not yet `done` or closed; other writes kept landing first, so retry; or an id was given as a prefix that more than one item's id starts with. → `Conflict` or `Blocked`

## DELETE /items/{id}

Delete an item.

Refused while another item names it as a parent or a dependency. The item's history outlives it.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string | The item's id, or a prefix of it at least 8 characters long, such as its `shortId`. |

- 204: Deleted, or already absent, which records nothing.
- 400: The request failed validation, or breaks the item graph. → `Error`
- 401: Missing or incorrect bearer token. → `Error`
- 409: Another item still references it, other writes kept landing first, or the id was given as a prefix that more than one item's id starts with. → `Conflict`

## GET /items/{id}/history

Read every write to an item and to everything beneath it.

One entry per create, update and delete, recorded by the service in the same transaction as the write, under the item written and every item above it at the time; a move files it under both sides. A write beneath an item is how a derived `status` changes, so that change has no entry of its own. No operation edits or removes an entry, and deleting an item leaves its history readable here.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string | The item's id, or a prefix of it at least 8 characters long, such as its `shortId`. |

- 200: The item's history. → {entries: `HistoryEntry`[]}
- 400: The request failed validation, or breaks the item graph. → `Error`
- 401: Missing or incorrect bearer token. → `Error`
- 404: No item with that id, and none ever recorded. → `Error`
- 409: An id was given as a prefix that more than one item's id starts with. → `Conflict`

## GET /items/{id}/comments

Read the comments on an item.

What people and workers said to each other about the item, not beneath it. Written by any caller and edited by none, apart from the item's fields and their `history`. Writing one changes nothing on the item and records no history entry.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string | The item's id, or a prefix of it at least 8 characters long, such as its `shortId`. |

- 200: The item's comments. → {comments: `Comment`[]}
- 400: The request failed validation, or breaks the item graph. → `Error`
- 401: Missing or incorrect bearer token. → `Error`
- 404: No item with that id. → `Error`
- 409: An id was given as a prefix that more than one item's id starts with. → `Conflict`

## POST /items/{id}/comments

Comment on an item.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string | The item's id, or a prefix of it at least 8 characters long, such as its `shortId`. |

Body: `CommentDraft`. The comment.

- 201: The comment, as stored. → `Comment`
- 400: The request failed validation, or breaks the item graph. → `Error`
- 401: Missing or incorrect bearer token. → `Error`
- 404: No item with that id. → `Error`
- 409: An id was given as a prefix that more than one item's id starts with. → `Conflict`

## GET /items/{id}/work-log

Read what was done on an item.

A worker's record of each step it finished on the item, kept apart from comments. Written by any caller and edited by none, apart from the item's fields and their `history`. Writing one changes nothing on the item and records no history entry.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string | The item's id, or a prefix of it at least 8 characters long, such as its `shortId`. |

- 200: The item's work log. → {entries: `WorkLogEntry`[]}
- 400: The request failed validation, or breaks the item graph. → `Error`
- 401: Missing or incorrect bearer token. → `Error`
- 404: No item with that id. → `Error`
- 409: An id was given as a prefix that more than one item's id starts with. → `Conflict`

## POST /items/{id}/work-log

Record a step done on an item.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string | The item's id, or a prefix of it at least 8 characters long, such as its `shortId`. |

Body: `WorkLogDraft`. What was done.

- 201: The entry, as stored. → `WorkLogEntry`
- 400: The request failed validation, or breaks the item graph. → `Error`
- 401: Missing or incorrect bearer token. → `Error`
- 404: No item with that id. → `Error`
- 409: An id was given as a prefix that more than one item's id starts with. → `Conflict`

## POST /items/{id}/assignment

Start an agent on an item.

The one way to start work on an item. In one write it records a new `assignment`, refused with 409 while the item's current one names an agent still live: not retired, and not stopped after saying `done`. On an item whose status is its own that write also moves it to `in_progress` held by the assignment's `name`, so it is refused with 409 as a move is while `blockedBy` is not empty; a parent not yet reading started is refused the same, as its Start. The item and everything beneath it leave the queue. Then worker-service makes the agent, named `name`, briefed with the item, labelled `ticket: <title>`, given the `tickets` document and stopped once it says `done`; its id is written to `assignment.agent`. A name already taken is the same agent made by an earlier try, and is taken as made. If worker-service makes none, the item is put back as it was and the refusal is answered with 502 in worker-service's words. A closed item is refused with 400.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string | The item's id, or a prefix of it at least 8 characters long, such as its `shortId`. |

- 201: The item, its `assignment` naming the agent made. → `WorkItemView`
- 400: The request failed validation, or breaks the item graph. → `Error`
- 401: Missing or incorrect bearer token. → `Error`
- 404: No item with that id. → `Error`
- 409: An agent still holds the item, named in `assignment`, or is still being made; a dependency is not yet `done` or closed; other writes kept landing first, so retry; or an id was given as a prefix that more than one item's id starts with. → `Assigned` or `Blocked` or `Conflict`
- 502: worker-service made no agent, in its words; the item is as it was. → `Error`
- 503: No address or token for worker-service is configured. → `Error`

## POST /items/{id}/tags

Add a tag to an item.

Adds one tag to `tags` on the item and on every item beneath it, open or closed, in one write. Each item it changes records its own `tags` change in `history`; one already carrying the tag is left alone and records nothing. Refused with 400, changing nothing, for a tag that does not exist, or for one past the 20 an item may carry on any item it reaches, naming those.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string | The item's id, or a prefix of it at least 8 characters long, such as its `shortId`. |

Body: `ItemTag`. The tag to add.

- 200: The item, carrying the tag. → `TaggedItemView`
- 400: The request failed validation, or breaks the item graph. → `Error`
- 401: Missing or incorrect bearer token. → `Error`
- 404: No item with that id. → `Error`
- 409: Other writes kept landing first, so retry; or an id was given as a prefix that more than one item's id starts with. → `Conflict`

## DELETE /items/{id}/tags/{tag}

Take a tag off an item.

Removes one tag from `tags` on the item and on every item beneath it, open or closed, in one write, each item it changes recording its own `tags` change in `history`. Items not carrying it, or a tag that does not exist, are left alone and record nothing. Taken off a child alone, its parent and siblings keep it.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string | The item's id, or a prefix of it at least 8 characters long, such as its `shortId`. |
| `tag` | path | string (min 1, max 40) | A tag's id, or its value in any case. |

- 200: The item, without the tag. → `TaggedItemView`
- 400: The request failed validation, or breaks the item graph. → `Error`
- 401: Missing or incorrect bearer token. → `Error`
- 404: No item with that id. → `Error`
- 409: Other writes kept landing first, so retry; or an id was given as a prefix that more than one item's id starts with. → `Conflict`

## POST /items/{id}/met

Tick one acceptance criterion as met.

Adds one tick to `met`, by the criterion's text, recording this write's `claimed-by` and now; every other tick stays as it stands when the write lands, so two writers ticking different criteria at once both keep theirs. One already ticked changes nothing and records no history; otherwise `history` records it as a `met` change. Refused with 400 for a criterion the item does not have.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string | The item's id, or a prefix of it at least 8 characters long, such as its `shortId`. |

Body: `Criterion`. The criterion to tick.

- 200: The item, with the criterion ticked. → `WorkItemView`
- 400: The request failed validation, or the item has no criterion with that text, named. → `Error`
- 401: Missing or incorrect bearer token. → `Error`
- 404: No item with that id. → `Error`
- 409: Other writes kept landing first, so retry; or an id was given as a prefix that more than one item's id starts with. → `Conflict`

## DELETE /items/{id}/met

Untick one acceptance criterion.

Removes that criterion's tick from `met`, leaving every other. One not ticked changes nothing and records no history. Refused with 400 for a criterion the item does not have.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string | The item's id, or a prefix of it at least 8 characters long, such as its `shortId`. |

Body: `Criterion`. The criterion to untick.

- 200: The item, without the criterion's tick. → `WorkItemView`
- 400: The request failed validation, or the item has no criterion with that text, named. → `Error`
- 401: Missing or incorrect bearer token. → `Error`
- 404: No item with that id. → `Error`
- 409: Other writes kept landing first, so retry; or an id was given as a prefix that more than one item's id starts with. → `Conflict`

## GET /queue

The queue: its running limit, what runs, what waits and why, and the dispatcher's last run.

The dispatcher runs every 5 minutes: while fewer than `limit` running places are taken, it requests an implementer for each `next` item in order. A queued epic is requested once, at the epic level, and what is queued beneath it leaves the queue. A blocked item keeps its place. An agent's state is read from worker-service on each call.

- 200: The queue. → `Queue`
- 400: The request failed validation, or breaks the item graph. → `Error`
- 401: Missing or incorrect bearer token. → `Error`

## PATCH /queue

Set the running limit: the person's write alone.

Raising it starts more on the dispatcher's next run, within 5 minutes. Lowering it stops nothing running: nothing new starts until fewer than it are.

Body: `QueuePatch`. The new limit.

- 200: The queue, at its new limit. → `Queue`
- 400: The request failed validation, or breaks the item graph. → `Error`
- 401: Missing or incorrect bearer token. → `Error`
- 403: Sent with a `claimed-by`: only the person sets the running limit. → `Error`

## GET /tags

List tags.

- 200: Every tag. → {tags: `Tag`[]}
- 400: The request failed validation, or breaks the item graph. → `Error`
- 401: Missing or incorrect bearer token. → `Error`

## POST /tags

Create a tag.

Body: `TagDraft`. The tag to create.

- 201: The created tag. → `Tag`
- 400: The request failed validation, or breaks the item graph. → `Error`
- 401: Missing or incorrect bearer token. → `Error`
- 409: Another tag already has the value, case-insensitively; or other writes kept landing first, so retry. → `TagTaken` or `Error`

## GET /tags/{id}

Read one tag.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string (uuid) | The tag's id. |

- 200: The tag. → `Tag`
- 400: The request failed validation, or breaks the item graph. → `Error`
- 401: Missing or incorrect bearer token. → `Error`
- 404: No tag with that id. → `Error`

## PATCH /tags/{id}

Update the tag's fields supplied, leaving the rest alone.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string (uuid) | The tag's id. |

Body: `TagPatch`. Fields to change.

- 200: The updated tag. → `Tag`
- 400: The request failed validation, or breaks the item graph. → `Error`
- 401: Missing or incorrect bearer token. → `Error`
- 404: No tag with that id. → `Error`
- 409: Another tag already has the value, case-insensitively; or other writes kept landing first, so retry. → `TagTaken` or `Error`

## DELETE /tags/{id}

Delete a tag.

Refused with 409 while any item, open or closed, carries it: take it off them first.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string (uuid) | The tag's id. |

- 204: Deleted, or already absent.
- 400: The request failed validation, or breaks the item graph. → `Error`
- 401: Missing or incorrect bearer token. → `Error`
- 409: Items still carry the tag, named by how many and the first few by short id; or other writes kept landing first, so retry. → `Error`

# Schemas

## Error

| Field | Type | |
| --- | --- | --- |
| `error` | string |  |

## WorkItemView

Every field of `WorkItem`, and:

| Field | Type | |
| --- | --- | --- |
| `status`? | `backlog`, `ready`, `in_progress`, `review`, `done` | Stored on an item without children. On a parent it is derived from its open children's statuses alone, by the first of these that holds: (1) every child `done` gives `done`; (2) no child `backlog`, `ready` or `in_progress` gives `review`; (3) any child `in_progress`, `review` or `done` gives `in_progress`; (4) every child `ready` gives `ready`; (5) otherwise `backlog`. A parent whose children are all closed counts them as all `done`. So finished work beside unstarted work reads `in_progress`, a parent reads `review` only when nothing beneath it is unstarted or in progress, and `done` once everything beneath it is, with no write to it; it reads `in_progress` or `review` again as soon as a child does. An item left without children reads its stored status. |
| `shortId` | string | The shortest prefix of `id`, at least 8 characters, that starts no other item's id: what people and workers call the item. Every route taking an item's id takes this too. A new item's id is drawn so its first 8 characters start no other's, so a `shortId` once read back never comes to name a second item. |
| `children` | string (uuid)[] | Items whose parent is this one. |
| `blockedBy` | string (uuid)[] | At every status, each dependency of this item, of any item above it, or of any open item below it not yet `done`, that is open and does not read `done`, or is no longer known. A dependency of an item below on this item or another below it is left out: that is work this one does. So a parent reads blocked for the same reasons its children do. A closed one, whatever its `closedReason` or `status`, does not hold anything up until it is reopened; one in `review` still does. While it is not empty, a move to `in_progress`, `review` or `done`, or under a new parent at one of those, is refused with 409. |
| `finishedEarly` | boolean | `done` while some dependency of its own is neither `done` nor closed: work finished before dependencies gated the move, or given a dependency once done. Derived on read and never stored, so it clears once every dependency is `done` or closed, or the item leaves `done`. |
| `queuePosition` | integer (≥ 0) or null | The item's place in the queue, 1 for the next to start, counting the open items with a `queuedAt` whose `status` reads `backlog` or `ready`, in the order queued; null when not among them. A parent queued while its children read as started is left out until they do not. Derived on read, so it moves up as soon as an item ahead is dequeued, closed or started. |

## Tick

| Field | Type | |
| --- | --- | --- |
| `criterion` | string | The criterion's text, as it stood when ticked. |
| `by` | string or null | The `claimed-by` of the write that ticked it, unverified; null when it said nothing. |
| `at` | string | When it was ticked. |

## Assignment

The agent last started on the item, by `POST /items/{id}/assignment`, kept after it finishes; null when none ever was. Written by that route alone, so it is the record of who works on the item, whatever its status.

| Field | Type | |
| --- | --- | --- |
| `id` | string (uuid) | Drawn when the assignment is made; a new start on the item makes a new one. |
| `agent` | string (uuid) or null | The agent's id in worker-service, written once worker-service has made it, or for the queue's start once it has recorded the request, whose id its agent takes; null while it is being made. |
| `name` | string | The agent's name, `<shortId>-<first 8 characters of id>`, or for the queue's start, once its request is recorded, `implementer-<first 8 characters of agent>`: who holds the item, and how a retry finds the agent already made. |
| `by` | string or null | The `claimed-by` of the request that made it, unverified; null when it said nothing, as the person's from the page. |
| `at` | string | When it was made. |
| `ended` | {at: string, why: string} or null | Null while the assignment stands. Set when the item is closed, or an item above it closes it, and kept on reopening: an ended assignment holds nothing, and the next start makes a new one without asking worker-service. |

## WorkItem

| Field | Type | |
| --- | --- | --- |
| `id` | string (uuid) |  |
| `type` | `epic`, `story`, `task` |  |
| `title` | string |  |
| `body` | string |  |
| `acceptanceCriteria` | string[] |  |
| `met` | `Tick`[] | The acceptance criteria a reviewer has ticked as met, in the order of `acceptanceCriteria`. Ticked and unticked one at a time by POST and DELETE `/items/{id}/met`, or all at once by a patch's `met`; a tick goes when its criterion's text changes or the criterion is dropped, so an edited criterion is met again only once ticked again. |
| `status` | `backlog`, `ready`, `in_progress`, `review`, `done` |  |
| `state` | `open`, `closed` | Whether anyone still needs to see the item, apart from where the work got to: `status` is never changed by closing, and reaching `done` does not close. Every item is created `open`. Closing an item closes what is open beneath it; reopening writes no other item. |
| `closedReason` | `completed`, `not_planned`, `null` | Why a closed item closed: `completed`, or `not_planned` for work abandoned at any status. Null while open. |
| `parent` | string (uuid) or null | Required, and exactly one level up: a task's is a story, a story's is an epic. An epic's is null. A create, move or re-type that breaks this is refused with 400. |
| `dependsOn` | string (uuid)[] | Items that must read `done`, or be closed, before this one moves to `in_progress`, `review` or `done`: see `blockedBy`. A dependency added to work already started holds up only its next move. Only between siblings: each one added must be of the item's own type with its parent, or the write is refused with 400 naming it; one stored before that rule is kept. A move to another parent is refused with 400 while it would leave the item, or an open item depending on it, depending on a non-sibling. |
| `createdAt` | string |  |
| `updatedAt` | string |  |
| `heldBy` | string or null | Who is on the item: the `claimed-by` of the write that last moved its stored `status` to `in_progress`, unverified like a history entry's `claimedBy`, and null if that write said nothing. Set by the service only. Kept through `review`; cleared by a move to `backlog`, `ready` or `done`, or by closing, and set again only by a later move to `in_progress`, so reopening alone leaves it null. A write that leaves `status` as it was leaves it as it was. Null while `status` is derived. |
| `reviewedBy` | string or null | The reviewer that last picked the item up for review, as approval-service's reviewer `reviewer-<id>`: written only by a write's `reviewedBy`, unverified like `heldBy`. Null until one is written. Kept through every move and closing, and replaced by the next review's write, so after a send-back it names the last reviewer until a new one picks it up. |
| `queuedAt` | string or null | When the item was queued to start on its own, by a write's `queued`; null when it is not queued. Cleared in the same write that closes the item, moves its stored `status` to `in_progress`, `review` or `done`. Queuing it again keeps the time. |
| `tags` | string (uuid)[] (at most 20) | The ids of the tags the item carries, at most 20, oldest added first: see `/tags`. Added and removed one at a time by `POST /items/{id}/tags` and `DELETE /items/{id}/tags/{tag}`, never by `POST /items` or `PATCH`, so two writers tagging one item never overwrite each other. Each is added to or removed from every item beneath, too. An item made under a parent, or moved under one with everything beneath it, takes on the parent's tags besides its own, each change in its history; moving away takes none off. A move giving any item a 21st is refused with 400 naming it. |
| `assignment` | `Assignment` |  |

## Conflict

Every field of `Error`, and:

| Field | Type | |
| --- | --- | --- |
| `matches`? | string (uuid)[] | When an id was given as a prefix that more than one item's id starts with: those items. |

## Blocked

Every field of `Error`, and:

| Field | Type | |
| --- | --- | --- |
| `blockedBy` | string (uuid)[] | The item's `blockedBy`: each dependency to wait for, named with its title and status in `error`. |

## Draft

| Field | Type | |
| --- | --- | --- |
| `type`? | `epic`, `story`, `task` |  |
| `title` | string (min 1, max 200) |  |
| `body`? | string (max 20000) |  |
| `acceptanceCriteria`? | string (min 1)[] (at most 50) | One line per criterion. |
| `status`? | `backlog`, `ready`, `in_progress`, `review`, `done` | Read back as given until the item has children. On a parent it is stored but has no effect while the parent has children, `done` included: a parent reads `done` by itself once every open child does, so there is nothing to sign off. Never changes a child. `in_progress`, `review` or `done` on a parent still reading `backlog` or `ready` is its Start: refused with 409 while its `blockedBy`, its children's blockers included, is not empty. |
| `parent`? | string or null | A story for a task, an epic for a story, null only for an epic. |
| `dependsOn`? | string[] (at most 50) |  |
| `tags`? | any | Not accepted: refused with 400 whatever its value. See `WorkItem.tags`. |

## UpdatedItem

Every field of `WorkItemView`, and:

| Field | Type | |
| --- | --- | --- |
| `agent`? | `AgentOutcome` |  |

## AgentOutcome

Present only on the person's sign-off of an epic (closing it `completed`) whose assignment names an agent: what was done to that agent. The close stands whatever it says.

| Field | Type | |
| --- | --- | --- |
| `id` | string (uuid) | The agent's id in worker-service, from the assignment. |
| `name` | string |  |
| `outcome` | `retired`, `already_retired`, `refused` | `retired`: worker-service retired it now. `already_retired`: it was retired, or worker-service has no record of it, so nothing was retired. `refused`: worker-service would not retire it, in `said`. |
| `said` | string | The outcome in a line for the person, with worker-service's words when it refused. |

## Patch

| Field | Type | |
| --- | --- | --- |
| `type`? | `epic`, `story`, `task` |  |
| `title`? | string (min 1, max 200) |  |
| `body`? | string (max 20000) |  |
| `acceptanceCriteria`? | string (min 1)[] (at most 50) |  |
| `met`? | string[] (at most 50) | Every criterion now met, by its text: replaces every tick held, so a tick another writer made since this one read the item is lost. To tick or untick one criterion, use POST or DELETE `/items/{id}/met`. One already ticked keeps who ticked it and when; one newly named is ticked by this write's `claimed-by`, now. Each must be one of the item's `acceptanceCriteria` as this write leaves them, or the write is refused with 400. |
| `status`? | `backlog`, `ready`, `in_progress`, `review`, `done` | Read back as given until the item has children. On a parent it is stored but has no effect while the parent has children, `done` included: a parent reads `done` by itself once every open child does, so there is nothing to sign off. Never changes a child. `in_progress`, `review` or `done` on a parent still reading `backlog` or `ready` is its Start: refused with 409 while its `blockedBy`, its children's blockers included, is not empty. |
| `state`? | `open`, `closed` | Closing closes everything still open beneath the item, for the same reason; reopening opens only the item, keeping its status. Closing an epic that has children as `completed` is the person's sign-off: refused with 403 from a write that sends `claimed-by`. |
| `closedReason`? | `completed`, `not_planned` | Required with, and only with, `state: closed`. |
| `parent`? | string or null | An item's id, or a prefix of it at least 8 characters long, such as its `shortId`. |
| `dependsOn`? | string[] (at most 50) |  |
| `reviewedBy`? | string (min 1, max 200) or null | The worker reviewing the item, as the reviewer's own name; null clears it. |
| `force`? | `true` | Move the item to `in_progress`, `review` or `done` though its `blockedBy` is not empty, recorded as the history entry's `overrode`. The person's alone: refused with 403 from a write that sends `claimed-by`, as every worker's does. Changes nothing on its own. |
| `queued`? | boolean | `true` queues the item to start on its own, at the back of the queue, or keeps its place if already queued; `false` takes it off. Only an open epic, story or task that reads `backlog` or `ready` can be queued, as this write leaves it: any other is refused with 400, naming why. Recorded in `history` as a change to `queuedAt`. |
| `tags`? | any | Not accepted: refused with 400 whatever its value. See `WorkItem.tags`. |

## HistoryEntry

| Field | Type | |
| --- | --- | --- |
| `item` | string (uuid) | The item written: this one, or one beneath it when the write was made. |
| `action` | `created`, `updated`, `deleted` |  |
| `changes` | `Change`[] | Each stored field whose value differs, as the item stood before and after. Empty when an update set every field to what it already held. |
| `at` | string | When the service recorded it. |
| `claimedBy` | string or null | The `claimed-by` header the write was sent with, unverified: callers sharing a token say who they are by it. Without one, the name of the write's token; null for an admin token's write that said nothing, the person's. |
| `overrode` | string (uuid)[] | The dependencies a `force` moved the item past, unfinished as the write found them: an override, made by the person since only a write with no `claimed-by` may force. Empty otherwise. |

## Change

| Field | Type | |
| --- | --- | --- |
| `field` | `type`, `title`, `body`, `acceptanceCriteria`, `met`, `status`, `heldBy`, `reviewedBy`, `state`, `closedReason`, `parent`, `dependsOn`, `queuedAt`, `tags`, `assignment` | `met` is recorded as the texts of the criteria ticked. |
| `from` | string or string[] or boolean or `Assignment` or any or null | Null on `created`. |
| `to` | string or string[] or boolean or `Assignment` or any or null | Null on `deleted`. |

## Comment

| Field | Type | |
| --- | --- | --- |
| `id` | string (uuid) |  |
| `item` | string (uuid) | The item it was written on. |
| `author` | string or null | The `claimed-by` header it was written with, unverified, as a history entry's `claimedBy`. Null when the writer said nothing, as a person writing from the page does. |
| `at` | string | When the service recorded it. |
| `body` | string (min 1, max 20000) | Markdown. |

## CommentDraft

| Field | Type | |
| --- | --- | --- |
| `body` | string (min 1, max 20000) | Markdown. |

## WorkLogEntry

Every field of `Comment`, and:

| Field | Type | |
| --- | --- | --- |
| `links` | string[] | Pull requests, commits or anything else the work left behind. |

## WorkLogDraft

| Field | Type | |
| --- | --- | --- |
| `body` | string (min 1, max 20000) | What was done, in Markdown. |
| `links`? | string (uri) (max 2000)[] (at most 20) |  |

## Assigned

Every field of `Error`, and:

| Field | Type | |
| --- | --- | --- |
| `assignment` | `Assignment` and any |  |

## TaggedItemView

Every field of `WorkItemView`, and:

| Field | Type | |
| --- | --- | --- |
| `reached` | integer (≥ 0) | How many items beneath this one the write changed. |

## ItemTag

| Field | Type | |
| --- | --- | --- |
| `tag` | string (min 1, max 40) | A tag's id, or its value in any case. |

## Criterion

| Field | Type | |
| --- | --- | --- |
| `criterion` | string (min 1) | The criterion's text, exactly as in `acceptanceCriteria`. |

## Queue

| Field | Type | |
| --- | --- | --- |
| `limit` | integer (≥ 1, ≤ 10) | How many queued items the dispatcher keeps running at once; 1 until the person sets it. |
| `running` | `QueueRunning`[] | Each item the queue started whose agent has started, oldest first. An item holds a running place, here or as `requested`, until it reads `review` or `done` (an epic by its derived status), is closed, or its agent is retired; an agent waiting on a question keeps it. |
| `queued` | `Queued`[] | The requests still waiting to be admitted, oldest first, then every item still queued, in order. |
| `last` | `LastRun` |  |

## QueueRunning

| Field | Type | |
| --- | --- | --- |
| `item` | `QueueItem` |  |
| `agent` | {id: string (uuid), name: string, state: `idle`, `working`, `waiting`, `interrupted`, `retired`, `unknown`} | The agent the queue's request started. |
| `startedAt` | string | When the queue requested it: its assignment's `at`. |

## QueueItem

| Field | Type | |
| --- | --- | --- |
| `id` | string (uuid) |  |
| `shortId` | string |  |
| `title` | string |  |
| `status` | `backlog`, `ready`, `in_progress`, `review`, `done` |  |

## Queued

| Field | Type | |
| --- | --- | --- |
| `item` | `QueueItem` |  |
| `position` | integer or null | Its `queuePosition`; null once `requested`, when it has left the queue's order. |
| `state` | `next`, `blocked`, `requested` | `next`: it starts, in `position` order, once a running place is free. `blocked`: it waits on `blockedBy` and keeps its place. `requested`: the queue asked worker-service for its agent, and the request still waits to be admitted, holding a running place. |
| `blockedBy` | `QueueItem`[] | While `blocked`: each item it waits on, its own dependency or one above or below it. |
| `request` | {id: string (uuid), name: string, why: string} or null | While `requested`, once the request is recorded; null otherwise. |

## LastRun

The dispatcher's last run; null before its first.

| Field | Type | |
| --- | --- | --- |
| `at` | string | When the dispatcher's last run ended. |
| `requested` | {item: string (uuid), shortId: string, request: string (uuid), worker: string, state: `waiting`, `started`, `withdrawn`, why: string or null}[] | The requests it made, in queue order. |
| `why` | string[] | Why it requested nothing more: what held each place, or what stopped it. |

## QueuePatch

| Field | Type | |
| --- | --- | --- |
| `limit` | integer (≥ 1, ≤ 10) | From 1 to 10. |

## Tag

| Field | Type | |
| --- | --- | --- |
| `id` | string (uuid) |  |
| `value` | string (min 1, max 40) | The text shown on the chip. Unique among tags case-insensitively. |
| `color` | string | The chip's background, `#rrggbb`, stored as given. |
| `description` | string (max 500) | What the tag is for, shown when hovering its chip. |
| `createdAt` | string |  |
| `updatedAt` | string |  |

## TagTaken

Every field of `Error`, and:

| Field | Type | |
| --- | --- | --- |
| `tag` | string (uuid) | The tag that already has the value. |

## TagDraft

| Field | Type | |
| --- | --- | --- |
| `value` | string (min 1, max 40) | The text shown on the chip. Unique among tags case-insensitively. |
| `color` | string | The chip's background, `#rrggbb`, stored as given. |
| `description`? | string (max 500) | What the tag is for, shown when hovering its chip. |

## TagPatch

| Field | Type | |
| --- | --- | --- |
| `value`? | string (min 1, max 40) | The text shown on the chip. Unique among tags case-insensitively. |
| `color`? | string | The chip's background, `#rrggbb`, stored as given. |
| `description`? | string (max 500) | What the tag is for, shown when hovering its chip. |
