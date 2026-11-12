# waypoint

> Version 0.1.0

One entity, the work item, at exactly three levels: an epic has no parent, every story has an epic, and every task has a story. `status` values are the board columns. A parent's `status` is derived from its open children's, by the rule on `WorkItemView.status`. `state` is separate: `open` until the item is closed, as `completed` or `not_planned`, from any status. An item may depend on its siblings, items of its type with its parent, and lists in `blockedBy` each dependency, its own or an item's above or below it, not yet `done` or closed. The service refuses with 409 a move to `in_progress`, `review` or `done` while `blockedBy` is not empty, and refuses a parent of the wrong type, a dependency on a non-sibling, a cycle, or deleting an item still referenced. Every create, update and delete is recorded in the item's `history`, which no operation edits. Beside its fields an item keeps `comments`, what people and workers say about it, and a `work-log`, what was done on it; neither changes the item or its history. A story or task not yet started can be `queued` to start on its own, in the order queued, as many at once as the queue's running limit: see `WorkItemView.queuePosition` and `/queue`. Acceptance criteria are ticked and unticked one at a time at `/items/{id}/met`. Tags, at `/tags`, are a shared list of labels, each a unique value, a colour and a description; an item carries some in `tags`, added and removed one at a time at `/items/{id}/tags`, each on the item and everything beneath it.


## Path Table

| Method | Path | Description |
| --- | --- | --- |
| GET | [/health](#gethealth) | Liveness check |
| GET | [/items](#getitems) | List items |
| POST | [/items](#postitems) | Create an item |
| GET | [/items/{id}](#getitemsid) | Read one item |
| PATCH | [/items/{id}](#patchitemsid) | Update the fields supplied, leaving the rest alone |
| DELETE | [/items/{id}](#deleteitemsid) | Delete an item |
| GET | [/items/{id}/history](#getitemsidhistory) | Read every write to an item and to everything beneath it |
| GET | [/items/{id}/comments](#getitemsidcomments) | Read the comments on an item |
| POST | [/items/{id}/comments](#postitemsidcomments) | Comment on an item |
| GET | [/items/{id}/work-log](#getitemsidwork-log) | Read what was done on an item |
| POST | [/items/{id}/work-log](#postitemsidwork-log) | Record a step done on an item |
| POST | [/items/{id}/tags](#postitemsidtags) | Add a tag to an item |
| DELETE | [/items/{id}/tags/{tag}](#deleteitemsidtagstag) | Take a tag off an item |
| POST | [/items/{id}/met](#postitemsidmet) | Tick one acceptance criterion as met |
| DELETE | [/items/{id}/met](#deleteitemsidmet) | Untick one acceptance criterion |
| GET | [/tags](#gettags) | List tags |
| POST | [/tags](#posttags) | Create a tag |
| GET | [/tags/{id}](#gettagsid) | Read one tag |
| PATCH | [/tags/{id}](#patchtagsid) | Update the tag's fields supplied, leaving the rest alone |
| DELETE | [/tags/{id}](#deletetagsid) | Delete a tag |

## Reference Table

| Name | Path | Description |
| --- | --- | --- |
| bearerAuth | [#/components/securitySchemes/bearerAuth](#componentssecurityschemesbearerauth) |  |
| WorkItemView | [#/components/schemas/WorkItemView](#componentsschemasworkitemview) |  |
| Tick | [#/components/schemas/Tick](#componentsschemastick) |  |
| Assignment | [#/components/schemas/Assignment](#componentsschemasassignment) | The agent last started on the item, by `POST /items/{id}/assignment`, kept after it finishes; null when none ever was. Written by that route alone, so it is the record of who works on the item, whatever its status. |
| WorkItem | [#/components/schemas/WorkItem](#componentsschemasworkitem) |  |
| Error | [#/components/schemas/Error](#componentsschemaserror) |  |
| Conflict | [#/components/schemas/Conflict](#componentsschemasconflict) |  |
| Blocked | [#/components/schemas/Blocked](#componentsschemasblocked) |  |
| Draft | [#/components/schemas/Draft](#componentsschemasdraft) |  |
| UpdatedItem | [#/components/schemas/UpdatedItem](#componentsschemasupdateditem) |  |
| AgentOutcome | [#/components/schemas/AgentOutcome](#componentsschemasagentoutcome) | Present only on the person's sign-off of an epic (closing it `completed`) whose assignment names an agent: what was done to that agent. The close stands whatever it says. |
| Patch | [#/components/schemas/Patch](#componentsschemaspatch) |  |
| HistoryEntry | [#/components/schemas/HistoryEntry](#componentsschemashistoryentry) |  |
| Change | [#/components/schemas/Change](#componentsschemaschange) |  |
| Comment | [#/components/schemas/Comment](#componentsschemascomment) |  |
| CommentDraft | [#/components/schemas/CommentDraft](#componentsschemascommentdraft) |  |
| WorkLogEntry | [#/components/schemas/WorkLogEntry](#componentsschemasworklogentry) |  |
| WorkLogDraft | [#/components/schemas/WorkLogDraft](#componentsschemasworklogdraft) |  |
| TaggedItemView | [#/components/schemas/TaggedItemView](#componentsschemastaggeditemview) |  |
| ItemTag | [#/components/schemas/ItemTag](#componentsschemasitemtag) |  |
| Criterion | [#/components/schemas/Criterion](#componentsschemascriterion) |  |
| Tag | [#/components/schemas/Tag](#componentsschemastag) |  |
| TagTaken | [#/components/schemas/TagTaken](#componentsschemastagtaken) |  |
| TagDraft | [#/components/schemas/TagDraft](#componentsschemastagdraft) |  |
| TagPatch | [#/components/schemas/TagPatch](#componentsschemastagpatch) |  |

## Path Details

***

### [GET]/health

- Summary  
  Liveness check

- Operation id  
  healthCheck

- Tags  
  meta

#### Responses

- 200 Service is up.

`application/json`

```typescript
{
  ok: enum[true]
  // The package's version.
  version: string
  // The commit this copy was built from: 40 hex characters, `-dirty` when its tree differed, or `unknown`.
  commit: string
}
```

***

### [GET]/items

- Summary  
  List items

- Operation id  
  listItems

- Description  
  Filters combine by AND. What can be started now is the `ready` items whose `blockedBy` is empty; any other is refused until it is.

- Tags  
  items

- Security  
  bearerAuth

#### Parameters(Query)

```typescript
status?: enum[backlog, ready, in_progress, review, done]
```

```typescript
// `open` for only what still needs looking at.
// `open` for only what still needs looking at.
state?: enum[open, closed]
```

```typescript
type?: enum[epic, story, task]
```

```typescript
// Only the children of this item, by its id or a prefix of it.
// Only the children of this item, by its id or a prefix of it.
parent?: string //pattern: ^[0-9a-fA-F-]{8,36}$
```

```typescript
// Only items whose `heldBy` is exactly this, as `heldBy=agent-1&state=open`.
// Only items whose `heldBy` is exactly this, as `heldBy=agent-1&state=open`.
heldBy?: string
```

```typescript
// Only items whose `reviewedBy` is exactly this.
// Only items whose `reviewedBy` is exactly this.
reviewedBy?: string
```

```typescript
// `true` for only the queue, listed in its order, next to start first; `false` for only what is not in it. See `WorkItemView.queuePosition`.
// `true` for only the queue, listed in its order, next to start first; `false` for only what is not in it. See `WorkItemView.queuePosition`.
queued?: enum[true, false]
```

```typescript
// Only items carrying this tag, by its id or its value in any case, as `tag=ui&state=open`. A tag that does not exist gives an empty list.
// Only items carrying this tag, by its id or its value in any case, as `tag=ui&state=open`. A tag that does not exist gives an empty list.
tag?: string
```

#### Responses

- 200 The matching items.

`application/json`

```typescript
{
  items: #/components/schemas/WorkItem & {
     // Stored on an item without children. On a parent it is derived from its open children's statuses alone, by the first of these that holds: (1) every child `done` gives `done`; (2) no child `backlog`, `ready` or `in_progress` gives `review`; (3) any child `in_progress`, `review` or `done` gives `in_progress`; (4) every child `ready` gives `ready`; (5) otherwise `backlog`. A parent whose children are all closed counts them as all `done`. So finished work beside unstarted work reads `in_progress`, a parent reads `review` only when nothing beneath it is unstarted or in progress, and `done` once everything beneath it is, with no write to it; it reads `in_progress` or `review` again as soon as a child does. An item left without children reads its stored status.
     status?: enum[backlog, ready, in_progress, review, done]
     // The shortest prefix of `id`, at least 8 characters, that starts no other item's id: what people and workers call the item. Every route taking an item's id takes this too. A new item's id is drawn so its first 8 characters start no other's, so a `shortId` once read back never comes to name a second item.
     shortId: string
     children: string[] //format: uuid
     blockedBy: string[] //format: uuid
     // `done` while some dependency of its own is neither `done` nor closed: work finished before dependencies gated the move, or given a dependency once done. Derived on read and never stored, so it clears once every dependency is `done` or closed, or the item leaves `done`.
     finishedEarly: boolean
     // The item's place in the queue, 1 for the next to start, counting the open items with a `queuedAt` whose `status` reads `backlog` or `ready`, in the order queued; null when not among them. A parent queued while its children read as started is left out until they do not. Derived on read, so it moves up as soon as an item ahead is dequeued, closed or started.
     queuePosition: integer | null //minimum: 0 //exclusiveMinimum: true
   }[]
}
```

- 400 The request failed validation, or breaks the item graph.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

***

### [POST]/items

- Summary  
  Create an item

- Operation id  
  createItem

- Tags  
  items

- Security  
  bearerAuth

#### Headers

```typescript
// Who is making the write, recorded in its history entry as said and not checked. Absent, the write is its token's: an admin token's is the person's, which alone may sign off an epic, force a move or set the queue's limit.
// Who is making the write, recorded in its history entry as said and not checked. Absent, the write is its token's: an admin token's is the person's, which alone may sign off an epic, force a move or set the queue's limit.
claimed-by?: string //minLength: 1 //maxLength: 200
```

#### RequestBody

The item to create.

- application/json

```typescript
{
  type?: enum[epic, story, task] //default: task
  title: string //minLength: 1 //maxLength: 200
  body?: string //maxLength: 20000 //default: 
  acceptanceCriteria?: string[] //minLength: 1 //maxItems: 50
  // Read back as given until the item has children. On a parent it is stored but has no effect while the parent has children, `done` included: a parent reads `done` by itself once every open child does, so there is nothing to sign off. Never changes a child. `in_progress`, `review` or `done` on a parent still reading `backlog` or `ready` is its Start: refused with 409 while its `blockedBy`, its children's blockers included, is not empty.
  status?: enum[backlog, ready, in_progress, review, done] //default: backlog
  // A story for a task, an epic for a story, null only for an epic.
  parent?: string | null //pattern: ^[0-9a-fA-F-]{8,36}$ //default: null
  // An item's id, or a prefix of it at least 8 characters long, such as its `shortId`.
  dependsOn?: string[] //pattern: ^[0-9a-fA-F-]{8,36}$ //maxItems: 50
  // Not accepted: refused with 400 whatever its value. See `WorkItem.tags`.
  tags?: any
}
```

#### Responses

- 201 The created item.

`application/json`

```typescript
#/components/schemas/WorkItem & {
   // Stored on an item without children. On a parent it is derived from its open children's statuses alone, by the first of these that holds: (1) every child `done` gives `done`; (2) no child `backlog`, `ready` or `in_progress` gives `review`; (3) any child `in_progress`, `review` or `done` gives `in_progress`; (4) every child `ready` gives `ready`; (5) otherwise `backlog`. A parent whose children are all closed counts them as all `done`. So finished work beside unstarted work reads `in_progress`, a parent reads `review` only when nothing beneath it is unstarted or in progress, and `done` once everything beneath it is, with no write to it; it reads `in_progress` or `review` again as soon as a child does. An item left without children reads its stored status.
   status?: enum[backlog, ready, in_progress, review, done]
   // The shortest prefix of `id`, at least 8 characters, that starts no other item's id: what people and workers call the item. Every route taking an item's id takes this too. A new item's id is drawn so its first 8 characters start no other's, so a `shortId` once read back never comes to name a second item.
   shortId: string
   children: string[] //format: uuid
   blockedBy: string[] //format: uuid
   // `done` while some dependency of its own is neither `done` nor closed: work finished before dependencies gated the move, or given a dependency once done. Derived on read and never stored, so it clears once every dependency is `done` or closed, or the item leaves `done`.
   finishedEarly: boolean
   // The item's place in the queue, 1 for the next to start, counting the open items with a `queuedAt` whose `status` reads `backlog` or `ready`, in the order queued; null when not among them. A parent queued while its children read as started is left out until they do not. Derived on read, so it moves up as soon as an item ahead is dequeued, closed or started.
   queuePosition: integer | null //minimum: 0 //exclusiveMinimum: true
 }
```

- 400 The request failed validation, or breaks the item graph.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 409 Created at `in_progress`, `review` or `done` with a dependency not yet `done` or closed; other writes kept landing first, so retry; or an id was given as a prefix that more than one item's id starts with.

`application/json`

```typescript
Partial(#/components/schemas/Conflict) & Partial(#/components/schemas/Blocked)
```

***

### [GET]/items/{id}

- Summary  
  Read one item

- Operation id  
  getItem

- Tags  
  items

- Security  
  bearerAuth

#### Parameters(Path)

```typescript
// The item's id, or a prefix of it at least 8 characters long, such as its `shortId`.
// The item's id, or a prefix of it at least 8 characters long, such as its `shortId`.
id: string
```

#### Responses

- 200 The item.

`application/json`

```typescript
#/components/schemas/WorkItem & {
   // Stored on an item without children. On a parent it is derived from its open children's statuses alone, by the first of these that holds: (1) every child `done` gives `done`; (2) no child `backlog`, `ready` or `in_progress` gives `review`; (3) any child `in_progress`, `review` or `done` gives `in_progress`; (4) every child `ready` gives `ready`; (5) otherwise `backlog`. A parent whose children are all closed counts them as all `done`. So finished work beside unstarted work reads `in_progress`, a parent reads `review` only when nothing beneath it is unstarted or in progress, and `done` once everything beneath it is, with no write to it; it reads `in_progress` or `review` again as soon as a child does. An item left without children reads its stored status.
   status?: enum[backlog, ready, in_progress, review, done]
   // The shortest prefix of `id`, at least 8 characters, that starts no other item's id: what people and workers call the item. Every route taking an item's id takes this too. A new item's id is drawn so its first 8 characters start no other's, so a `shortId` once read back never comes to name a second item.
   shortId: string
   children: string[] //format: uuid
   blockedBy: string[] //format: uuid
   // `done` while some dependency of its own is neither `done` nor closed: work finished before dependencies gated the move, or given a dependency once done. Derived on read and never stored, so it clears once every dependency is `done` or closed, or the item leaves `done`.
   finishedEarly: boolean
   // The item's place in the queue, 1 for the next to start, counting the open items with a `queuedAt` whose `status` reads `backlog` or `ready`, in the order queued; null when not among them. A parent queued while its children read as started is left out until they do not. Derived on read, so it moves up as soon as an item ahead is dequeued, closed or started.
   queuePosition: integer | null //minimum: 0 //exclusiveMinimum: true
 }
```

- 400 The request failed validation, or breaks the item graph.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 404 No item with that id.

`application/json`

```typescript
{
  error: string
}
```

- 409 An id was given as a prefix that more than one item's id starts with.

`application/json`

```typescript
#/components/schemas/Error & {
   matches?: string[] //format: uuid
 }
```

***

### [PATCH]/items/{id}

- Summary  
  Update the fields supplied, leaving the rest alone

- Operation id  
  updateItem

- Description  
  Setting `done` on a parent whose open children are not all `done` is refused with 400. Moving an item to `in_progress`, `review` or `done`, or under a new parent while there, is refused with 409 while its `blockedBy` is not empty, unless the person sends `force`. A parent's status follows its children's, whatever is written to it, but writing it `in_progress`, `review` or `done` while it reads `backlog` or `ready` is its Start, refused the same way.

- Tags  
  items

- Security  
  bearerAuth

#### Parameters(Path)

```typescript
// The item's id, or a prefix of it at least 8 characters long, such as its `shortId`.
// The item's id, or a prefix of it at least 8 characters long, such as its `shortId`.
id: string
```

#### Headers

```typescript
// Who is making the write, recorded in its history entry as said and not checked. Absent, the write is its token's: an admin token's is the person's, which alone may sign off an epic, force a move or set the queue's limit.
// Who is making the write, recorded in its history entry as said and not checked. Absent, the write is its token's: an admin token's is the person's, which alone may sign off an epic, force a move or set the queue's limit.
claimed-by?: string //minLength: 1 //maxLength: 200
```

#### RequestBody

Fields to change.

- application/json

```typescript
{
  type?: enum[epic, story, task]
  title?: string //minLength: 1 //maxLength: 200
  body?: string //maxLength: 20000
  acceptanceCriteria?: string[] //minLength: 1 //maxItems: 50
  met?: string[] //maxItems: 50
  // Read back as given until the item has children. On a parent it is stored but has no effect while the parent has children, `done` included: a parent reads `done` by itself once every open child does, so there is nothing to sign off. Never changes a child. `in_progress`, `review` or `done` on a parent still reading `backlog` or `ready` is its Start: refused with 409 while its `blockedBy`, its children's blockers included, is not empty.
  status?: enum[backlog, ready, in_progress, review, done]
  // Closing closes everything still open beneath the item, for the same reason; reopening opens only the item, keeping its status. Closing an epic that has children as `completed` is the person's sign-off: refused with 403 from a write that sends `claimed-by`.
  state?: enum[open, closed]
  // Required with, and only with, `state: closed`.
  closedReason?: enum[completed, not_planned]
  // An item's id, or a prefix of it at least 8 characters long, such as its `shortId`.
  parent?: string | null //pattern: ^[0-9a-fA-F-]{8,36}$
  // An item's id, or a prefix of it at least 8 characters long, such as its `shortId`.
  dependsOn?: string[] //pattern: ^[0-9a-fA-F-]{8,36}$ //maxItems: 50
  // The worker reviewing the item, as the reviewer's own name; null clears it.
  reviewedBy?: string | null //minLength: 1 //maxLength: 200
  // Move the item to `in_progress`, `review` or `done` though its `blockedBy` is not empty, recorded as the history entry's `overrode`. The person's alone: refused with 403 from a write that sends `claimed-by`, as every worker's does. Changes nothing on its own.
  force?: enum[true]
  // `true` queues the item to start on its own, at the back of the queue, or keeps its place if already queued; `false` takes it off. Only an open epic, story or task that reads `backlog` or `ready` can be queued, as this write leaves it: any other is refused with 400, naming why. Recorded in `history` as a change to `queuedAt`.
  queued?: boolean
  // Not accepted: refused with 400 whatever its value. See `WorkItem.tags`.
  tags?: any
}
```

#### Responses

- 200 The updated item.

`application/json`

```typescript
#/components/schemas/WorkItemView & {
   // Present only on the person's sign-off of an epic (closing it `completed`) whose assignment names an agent: what was done to that agent. The close stands whatever it says.
   agent: {
     // The agent's id in worker-service, from the assignment.
     id: string //format: uuid
     name: string
     // `retired`: worker-service retired it now. `already_retired`: it was retired, or worker-service has no record of it, so nothing was retired. `refused`: worker-service would not retire it, in `said`.
     outcome: enum[retired, already_retired, refused]
     // The outcome in a line for the person, with worker-service's words when it refused.
     said: string
   }
 }
```

- 400 The request failed validation, or breaks the item graph.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 403 Sent with a `claimed-by`, a `force`, or closing an epic that has children as `completed`: only the person may override `blockedBy` or sign off an epic.

`application/json`

```typescript
{
  error: string
}
```

- 404 No item with that id.

`application/json`

```typescript
{
  error: string
}
```

- 409 A dependency is not yet `done` or closed; other writes kept landing first, so retry; or an id was given as a prefix that more than one item's id starts with.

`application/json`

```typescript
Partial(#/components/schemas/Conflict) & Partial(#/components/schemas/Blocked)
```

***

### [DELETE]/items/{id}

- Summary  
  Delete an item

- Operation id  
  deleteItem

- Description  
  Refused while another item names it as a parent or a dependency. The item's history outlives it.

- Tags  
  items

- Security  
  bearerAuth

#### Parameters(Path)

```typescript
// The item's id, or a prefix of it at least 8 characters long, such as its `shortId`.
// The item's id, or a prefix of it at least 8 characters long, such as its `shortId`.
id: string
```

#### Headers

```typescript
// Who is making the write, recorded in its history entry as said and not checked. Absent, the write is its token's: an admin token's is the person's, which alone may sign off an epic, force a move or set the queue's limit.
// Who is making the write, recorded in its history entry as said and not checked. Absent, the write is its token's: an admin token's is the person's, which alone may sign off an epic, force a move or set the queue's limit.
claimed-by?: string //minLength: 1 //maxLength: 200
```

#### Responses

- 204 Deleted, or already absent, which records nothing.

- 400 The request failed validation, or breaks the item graph.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 409 Another item still references it, other writes kept landing first, or the id was given as a prefix that more than one item's id starts with.

`application/json`

```typescript
#/components/schemas/Error & {
   matches?: string[] //format: uuid
 }
```

***

### [GET]/items/{id}/history

- Summary  
  Read every write to an item and to everything beneath it

- Operation id  
  getItemHistory

- Description  
  One entry per create, update and delete, recorded by the service in the same transaction as the write, under the item written and every item above it at the time; a move files it under both sides. A write beneath an item is how a derived `status` changes, so that change has no entry of its own. No operation edits or removes an entry, and deleting an item leaves its history readable here.

- Tags  
  items

- Security  
  bearerAuth

#### Parameters(Path)

```typescript
// The item's id, or a prefix of it at least 8 characters long, such as its `shortId`.
// The item's id, or a prefix of it at least 8 characters long, such as its `shortId`.
id: string
```

#### Responses

- 200 The item's history.

`application/json`

```typescript
{
  entries: {
    // The item written: this one, or one beneath it when the write was made.
    item: string //format: uuid
    action: enum[created, updated, deleted]
    changes: {
      // `met` is recorded as the texts of the criteria ticked.
      field: enum[type, title, body, acceptanceCriteria, met, status, heldBy, reviewedBy, state, closedReason, parent, dependsOn, queuedAt, tags, assignment]
      // Null on `created`.
      from: Partial(string) & Partial(string[]) & Partial(boolean) & Partial(#/components/schemas/Assignment) & Partial()
      // Null on `deleted`.
      to: Partial(string) & Partial(string[]) & Partial(boolean) & Partial(#/components/schemas/Assignment) & Partial()
    }[]
    // When the service recorded it.
    at: string
    // The `claimed-by` header the write was sent with, unverified: callers sharing a token say who they are by it. Without one, the name of the write's token; null for an admin token's write that said nothing, the person's.
    claimedBy: string | null
    overrode: string[] //format: uuid
  }[]
}
```

- 400 The request failed validation, or breaks the item graph.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 404 No item with that id, and none ever recorded.

`application/json`

```typescript
{
  error: string
}
```

- 409 An id was given as a prefix that more than one item's id starts with.

`application/json`

```typescript
#/components/schemas/Error & {
   matches?: string[] //format: uuid
 }
```

***

### [GET]/items/{id}/comments

- Summary  
  Read the comments on an item

- Operation id  
  listItemComments

- Description  
  What people and workers said to each other about the item, not beneath it. Written by any caller and edited by none, apart from the item's fields and their `history`. Writing one changes nothing on the item and records no history entry.

- Tags  
  items

- Security  
  bearerAuth

#### Parameters(Path)

```typescript
// The item's id, or a prefix of it at least 8 characters long, such as its `shortId`.
// The item's id, or a prefix of it at least 8 characters long, such as its `shortId`.
id: string
```

#### Responses

- 200 The item's comments.

`application/json`

```typescript
{
  comments: {
    id: string //format: uuid
    // The item it was written on.
    item: string //format: uuid
    // The `claimed-by` header it was written with, unverified, as a history entry's `claimedBy`. Null when the writer said nothing, as a person writing from the page does.
    author: string | null
    // When the service recorded it.
    at: string
    // Markdown.
    body: string //minLength: 1 //maxLength: 20000
  }[]
}
```

- 400 The request failed validation, or breaks the item graph.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 404 No item with that id.

`application/json`

```typescript
{
  error: string
}
```

- 409 An id was given as a prefix that more than one item's id starts with.

`application/json`

```typescript
#/components/schemas/Error & {
   matches?: string[] //format: uuid
 }
```

***

### [POST]/items/{id}/comments

- Summary  
  Comment on an item

- Operation id  
  addItemComment

- Tags  
  items

- Security  
  bearerAuth

#### Parameters(Path)

```typescript
// The item's id, or a prefix of it at least 8 characters long, such as its `shortId`.
// The item's id, or a prefix of it at least 8 characters long, such as its `shortId`.
id: string
```

#### Headers

```typescript
// Who is making the write, recorded in its history entry as said and not checked. Absent, the write is its token's: an admin token's is the person's, which alone may sign off an epic, force a move or set the queue's limit.
// Who is making the write, recorded in its history entry as said and not checked. Absent, the write is its token's: an admin token's is the person's, which alone may sign off an epic, force a move or set the queue's limit.
claimed-by?: string //minLength: 1 //maxLength: 200
```

#### RequestBody

The comment.

- application/json

```typescript
{
  // Markdown.
  body: string //minLength: 1 //maxLength: 20000
}
```

#### Responses

- 201 The comment, as stored.

`application/json`

```typescript
{
  id: string //format: uuid
  // The item it was written on.
  item: string //format: uuid
  // The `claimed-by` header it was written with, unverified, as a history entry's `claimedBy`. Null when the writer said nothing, as a person writing from the page does.
  author: string | null
  // When the service recorded it.
  at: string
  // Markdown.
  body: string //minLength: 1 //maxLength: 20000
}
```

- 400 The request failed validation, or breaks the item graph.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 404 No item with that id.

`application/json`

```typescript
{
  error: string
}
```

- 409 An id was given as a prefix that more than one item's id starts with.

`application/json`

```typescript
#/components/schemas/Error & {
   matches?: string[] //format: uuid
 }
```

***

### [GET]/items/{id}/work-log

- Summary  
  Read what was done on an item

- Operation id  
  listItemWorkLog

- Description  
  A worker's record of each step it finished on the item, kept apart from comments. Written by any caller and edited by none, apart from the item's fields and their `history`. Writing one changes nothing on the item and records no history entry.

- Tags  
  items

- Security  
  bearerAuth

#### Parameters(Path)

```typescript
// The item's id, or a prefix of it at least 8 characters long, such as its `shortId`.
// The item's id, or a prefix of it at least 8 characters long, such as its `shortId`.
id: string
```

#### Responses

- 200 The item's work log.

`application/json`

```typescript
{
  entries: #/components/schemas/Comment & {
     links: string[]
   }[]
}
```

- 400 The request failed validation, or breaks the item graph.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 404 No item with that id.

`application/json`

```typescript
{
  error: string
}
```

- 409 An id was given as a prefix that more than one item's id starts with.

`application/json`

```typescript
#/components/schemas/Error & {
   matches?: string[] //format: uuid
 }
```

***

### [POST]/items/{id}/work-log

- Summary  
  Record a step done on an item

- Operation id  
  addItemWorkLogEntry

- Tags  
  items

- Security  
  bearerAuth

#### Parameters(Path)

```typescript
// The item's id, or a prefix of it at least 8 characters long, such as its `shortId`.
// The item's id, or a prefix of it at least 8 characters long, such as its `shortId`.
id: string
```

#### Headers

```typescript
// Who is making the write, recorded in its history entry as said and not checked. Absent, the write is its token's: an admin token's is the person's, which alone may sign off an epic, force a move or set the queue's limit.
// Who is making the write, recorded in its history entry as said and not checked. Absent, the write is its token's: an admin token's is the person's, which alone may sign off an epic, force a move or set the queue's limit.
claimed-by?: string //minLength: 1 //maxLength: 200
```

#### RequestBody

What was done.

- application/json

```typescript
{
  // What was done, in Markdown.
  body: string //minLength: 1 //maxLength: 20000
  links?: string[] //format: uri //maxLength: 2000 //maxItems: 20
}
```

#### Responses

- 201 The entry, as stored.

`application/json`

```typescript
#/components/schemas/Comment & {
   links: string[]
 }
```

- 400 The request failed validation, or breaks the item graph.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 404 No item with that id.

`application/json`

```typescript
{
  error: string
}
```

- 409 An id was given as a prefix that more than one item's id starts with.

`application/json`

```typescript
#/components/schemas/Error & {
   matches?: string[] //format: uuid
 }
```

***

### [POST]/items/{id}/tags

- Summary  
  Add a tag to an item

- Operation id  
  addItemTag

- Description  
  Adds one tag to `tags` on the item and on every item beneath it, open or closed, in one write. Each item it changes records its own `tags` change in `history`; one already carrying the tag is left alone and records nothing. Refused with 400, changing nothing, for a tag that does not exist, or for one past the 20 an item may carry on any item it reaches, naming those.

- Tags  
  items

- Security  
  bearerAuth

#### Parameters(Path)

```typescript
// The item's id, or a prefix of it at least 8 characters long, such as its `shortId`.
// The item's id, or a prefix of it at least 8 characters long, such as its `shortId`.
id: string
```

#### Headers

```typescript
// Who is making the write, recorded in its history entry as said and not checked. Absent, the write is its token's: an admin token's is the person's, which alone may sign off an epic, force a move or set the queue's limit.
// Who is making the write, recorded in its history entry as said and not checked. Absent, the write is its token's: an admin token's is the person's, which alone may sign off an epic, force a move or set the queue's limit.
claimed-by?: string //minLength: 1 //maxLength: 200
```

#### RequestBody

The tag to add.

- application/json

```typescript
{
  // A tag's id, or its value in any case.
  tag: string //minLength: 1 //maxLength: 40
}
```

#### Responses

- 200 The item, carrying the tag.

`application/json`

```typescript
#/components/schemas/WorkItemView & {
   // How many items beneath this one the write changed.
   reached: integer //minimum: 0
 }
```

- 400 The request failed validation, or breaks the item graph.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 404 No item with that id.

`application/json`

```typescript
{
  error: string
}
```

- 409 Other writes kept landing first, so retry; or an id was given as a prefix that more than one item's id starts with.

`application/json`

```typescript
#/components/schemas/Error & {
   matches?: string[] //format: uuid
 }
```

***

### [DELETE]/items/{id}/tags/{tag}

- Summary  
  Take a tag off an item

- Operation id  
  removeItemTag

- Description  
  Removes one tag from `tags` on the item and on every item beneath it, open or closed, in one write, each item it changes recording its own `tags` change in `history`. Items not carrying it, or a tag that does not exist, are left alone and record nothing. Taken off a child alone, its parent and siblings keep it.

- Tags  
  items

- Security  
  bearerAuth

#### Parameters(Path)

```typescript
// The item's id, or a prefix of it at least 8 characters long, such as its `shortId`.
// The item's id, or a prefix of it at least 8 characters long, such as its `shortId`.
id: string
```

```typescript
// A tag's id, or its value in any case.
// A tag's id, or its value in any case.
tag: string //minLength: 1 //maxLength: 40
```

#### Headers

```typescript
// Who is making the write, recorded in its history entry as said and not checked. Absent, the write is its token's: an admin token's is the person's, which alone may sign off an epic, force a move or set the queue's limit.
// Who is making the write, recorded in its history entry as said and not checked. Absent, the write is its token's: an admin token's is the person's, which alone may sign off an epic, force a move or set the queue's limit.
claimed-by?: string //minLength: 1 //maxLength: 200
```

#### Responses

- 200 The item, without the tag.

`application/json`

```typescript
#/components/schemas/WorkItemView & {
   // How many items beneath this one the write changed.
   reached: integer //minimum: 0
 }
```

- 400 The request failed validation, or breaks the item graph.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 404 No item with that id.

`application/json`

```typescript
{
  error: string
}
```

- 409 Other writes kept landing first, so retry; or an id was given as a prefix that more than one item's id starts with.

`application/json`

```typescript
#/components/schemas/Error & {
   matches?: string[] //format: uuid
 }
```

***

### [POST]/items/{id}/met

- Summary  
  Tick one acceptance criterion as met

- Operation id  
  tickCriterion

- Description  
  Adds one tick to `met`, by the criterion's text, recording this write's `claimed-by` and now; every other tick stays as it stands when the write lands, so two writers ticking different criteria at once both keep theirs. One already ticked changes nothing and records no history; otherwise `history` records it as a `met` change. Refused with 400 for a criterion the item does not have.

- Tags  
  items

- Security  
  bearerAuth

#### Parameters(Path)

```typescript
// The item's id, or a prefix of it at least 8 characters long, such as its `shortId`.
// The item's id, or a prefix of it at least 8 characters long, such as its `shortId`.
id: string
```

#### Headers

```typescript
// Who is making the write, recorded in its history entry as said and not checked. Absent, the write is its token's: an admin token's is the person's, which alone may sign off an epic, force a move or set the queue's limit.
// Who is making the write, recorded in its history entry as said and not checked. Absent, the write is its token's: an admin token's is the person's, which alone may sign off an epic, force a move or set the queue's limit.
claimed-by?: string //minLength: 1 //maxLength: 200
```

#### RequestBody

The criterion to tick.

- application/json

```typescript
{
  // The criterion's text, exactly as in `acceptanceCriteria`.
  criterion: string //minLength: 1
}
```

#### Responses

- 200 The item, with the criterion ticked.

`application/json`

```typescript
#/components/schemas/WorkItem & {
   // Stored on an item without children. On a parent it is derived from its open children's statuses alone, by the first of these that holds: (1) every child `done` gives `done`; (2) no child `backlog`, `ready` or `in_progress` gives `review`; (3) any child `in_progress`, `review` or `done` gives `in_progress`; (4) every child `ready` gives `ready`; (5) otherwise `backlog`. A parent whose children are all closed counts them as all `done`. So finished work beside unstarted work reads `in_progress`, a parent reads `review` only when nothing beneath it is unstarted or in progress, and `done` once everything beneath it is, with no write to it; it reads `in_progress` or `review` again as soon as a child does. An item left without children reads its stored status.
   status?: enum[backlog, ready, in_progress, review, done]
   // The shortest prefix of `id`, at least 8 characters, that starts no other item's id: what people and workers call the item. Every route taking an item's id takes this too. A new item's id is drawn so its first 8 characters start no other's, so a `shortId` once read back never comes to name a second item.
   shortId: string
   children: string[] //format: uuid
   blockedBy: string[] //format: uuid
   // `done` while some dependency of its own is neither `done` nor closed: work finished before dependencies gated the move, or given a dependency once done. Derived on read and never stored, so it clears once every dependency is `done` or closed, or the item leaves `done`.
   finishedEarly: boolean
   // The item's place in the queue, 1 for the next to start, counting the open items with a `queuedAt` whose `status` reads `backlog` or `ready`, in the order queued; null when not among them. A parent queued while its children read as started is left out until they do not. Derived on read, so it moves up as soon as an item ahead is dequeued, closed or started.
   queuePosition: integer | null //minimum: 0 //exclusiveMinimum: true
 }
```

- 400 The request failed validation, or the item has no criterion with that text, named.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 404 No item with that id.

`application/json`

```typescript
{
  error: string
}
```

- 409 Other writes kept landing first, so retry; or an id was given as a prefix that more than one item's id starts with.

`application/json`

```typescript
#/components/schemas/Error & {
   matches?: string[] //format: uuid
 }
```

***

### [DELETE]/items/{id}/met

- Summary  
  Untick one acceptance criterion

- Operation id  
  untickCriterion

- Description  
  Removes that criterion's tick from `met`, leaving every other. One not ticked changes nothing and records no history. Refused with 400 for a criterion the item does not have.

- Tags  
  items

- Security  
  bearerAuth

#### Parameters(Path)

```typescript
// The item's id, or a prefix of it at least 8 characters long, such as its `shortId`.
// The item's id, or a prefix of it at least 8 characters long, such as its `shortId`.
id: string
```

#### Headers

```typescript
// Who is making the write, recorded in its history entry as said and not checked. Absent, the write is its token's: an admin token's is the person's, which alone may sign off an epic, force a move or set the queue's limit.
// Who is making the write, recorded in its history entry as said and not checked. Absent, the write is its token's: an admin token's is the person's, which alone may sign off an epic, force a move or set the queue's limit.
claimed-by?: string //minLength: 1 //maxLength: 200
```

#### RequestBody

The criterion to untick.

- application/json

```typescript
{
  // The criterion's text, exactly as in `acceptanceCriteria`.
  criterion: string //minLength: 1
}
```

#### Responses

- 200 The item, without the criterion's tick.

`application/json`

```typescript
#/components/schemas/WorkItem & {
   // Stored on an item without children. On a parent it is derived from its open children's statuses alone, by the first of these that holds: (1) every child `done` gives `done`; (2) no child `backlog`, `ready` or `in_progress` gives `review`; (3) any child `in_progress`, `review` or `done` gives `in_progress`; (4) every child `ready` gives `ready`; (5) otherwise `backlog`. A parent whose children are all closed counts them as all `done`. So finished work beside unstarted work reads `in_progress`, a parent reads `review` only when nothing beneath it is unstarted or in progress, and `done` once everything beneath it is, with no write to it; it reads `in_progress` or `review` again as soon as a child does. An item left without children reads its stored status.
   status?: enum[backlog, ready, in_progress, review, done]
   // The shortest prefix of `id`, at least 8 characters, that starts no other item's id: what people and workers call the item. Every route taking an item's id takes this too. A new item's id is drawn so its first 8 characters start no other's, so a `shortId` once read back never comes to name a second item.
   shortId: string
   children: string[] //format: uuid
   blockedBy: string[] //format: uuid
   // `done` while some dependency of its own is neither `done` nor closed: work finished before dependencies gated the move, or given a dependency once done. Derived on read and never stored, so it clears once every dependency is `done` or closed, or the item leaves `done`.
   finishedEarly: boolean
   // The item's place in the queue, 1 for the next to start, counting the open items with a `queuedAt` whose `status` reads `backlog` or `ready`, in the order queued; null when not among them. A parent queued while its children read as started is left out until they do not. Derived on read, so it moves up as soon as an item ahead is dequeued, closed or started.
   queuePosition: integer | null //minimum: 0 //exclusiveMinimum: true
 }
```

- 400 The request failed validation, or the item has no criterion with that text, named.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 404 No item with that id.

`application/json`

```typescript
{
  error: string
}
```

- 409 Other writes kept landing first, so retry; or an id was given as a prefix that more than one item's id starts with.

`application/json`

```typescript
#/components/schemas/Error & {
   matches?: string[] //format: uuid
 }
```

***

### [GET]/tags

- Summary  
  List tags

- Operation id  
  listTags

- Tags  
  tags

- Security  
  bearerAuth

#### Responses

- 200 Every tag.

`application/json`

```typescript
{
  tags: {
    id: string //format: uuid
    // The text shown on the chip. Unique among tags case-insensitively.
    value: string //minLength: 1 //maxLength: 40
    // The chip's background, `#rrggbb`, stored as given.
    color: string //pattern: ^#[0-9a-fA-F]{6}$
    // What the tag is for, shown when hovering its chip.
    description: string //maxLength: 500
    createdAt: string
    updatedAt: string
  }[]
}
```

- 400 The request failed validation, or breaks the item graph.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

***

### [POST]/tags

- Summary  
  Create a tag

- Operation id  
  createTag

- Tags  
  tags

- Security  
  bearerAuth

#### RequestBody

The tag to create.

- application/json

```typescript
{
  // The text shown on the chip. Unique among tags case-insensitively.
  value: string //minLength: 1 //maxLength: 40
  // The chip's background, `#rrggbb`, stored as given.
  color: string //pattern: ^#[0-9a-fA-F]{6}$
  // What the tag is for, shown when hovering its chip.
  description?: string //maxLength: 500 //default: 
}
```

#### Responses

- 201 The created tag.

`application/json`

```typescript
{
  id: string //format: uuid
  // The text shown on the chip. Unique among tags case-insensitively.
  value: string //minLength: 1 //maxLength: 40
  // The chip's background, `#rrggbb`, stored as given.
  color: string //pattern: ^#[0-9a-fA-F]{6}$
  // What the tag is for, shown when hovering its chip.
  description: string //maxLength: 500
  createdAt: string
  updatedAt: string
}
```

- 400 The request failed validation, or breaks the item graph.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 409 Another tag already has the value, case-insensitively; or other writes kept landing first, so retry.

`application/json`

```typescript
Partial(#/components/schemas/TagTaken) & Partial(#/components/schemas/Error)
```

***

### [GET]/tags/{id}

- Summary  
  Read one tag

- Operation id  
  getTag

- Tags  
  tags

- Security  
  bearerAuth

#### Parameters(Path)

```typescript
// The tag's id.
// The tag's id.
id: string //format: uuid
```

#### Responses

- 200 The tag.

`application/json`

```typescript
{
  id: string //format: uuid
  // The text shown on the chip. Unique among tags case-insensitively.
  value: string //minLength: 1 //maxLength: 40
  // The chip's background, `#rrggbb`, stored as given.
  color: string //pattern: ^#[0-9a-fA-F]{6}$
  // What the tag is for, shown when hovering its chip.
  description: string //maxLength: 500
  createdAt: string
  updatedAt: string
}
```

- 400 The request failed validation, or breaks the item graph.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 404 No tag with that id.

`application/json`

```typescript
{
  error: string
}
```

***

### [PATCH]/tags/{id}

- Summary  
  Update the tag's fields supplied, leaving the rest alone

- Operation id  
  updateTag

- Tags  
  tags

- Security  
  bearerAuth

#### Parameters(Path)

```typescript
// The tag's id.
// The tag's id.
id: string //format: uuid
```

#### RequestBody

Fields to change.

- application/json

```typescript
{
  // The text shown on the chip. Unique among tags case-insensitively.
  value?: string //minLength: 1 //maxLength: 40
  // The chip's background, `#rrggbb`, stored as given.
  color?: string //pattern: ^#[0-9a-fA-F]{6}$
  // What the tag is for, shown when hovering its chip.
  description?: string //maxLength: 500
}
```

#### Responses

- 200 The updated tag.

`application/json`

```typescript
{
  id: string //format: uuid
  // The text shown on the chip. Unique among tags case-insensitively.
  value: string //minLength: 1 //maxLength: 40
  // The chip's background, `#rrggbb`, stored as given.
  color: string //pattern: ^#[0-9a-fA-F]{6}$
  // What the tag is for, shown when hovering its chip.
  description: string //maxLength: 500
  createdAt: string
  updatedAt: string
}
```

- 400 The request failed validation, or breaks the item graph.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 404 No tag with that id.

`application/json`

```typescript
{
  error: string
}
```

- 409 Another tag already has the value, case-insensitively; or other writes kept landing first, so retry.

`application/json`

```typescript
Partial(#/components/schemas/TagTaken) & Partial(#/components/schemas/Error)
```

***

### [DELETE]/tags/{id}

- Summary  
  Delete a tag

- Operation id  
  deleteTag

- Description  
  Refused with 409 while any item, open or closed, carries it: take it off them first.

- Tags  
  tags

- Security  
  bearerAuth

#### Parameters(Path)

```typescript
// The tag's id.
// The tag's id.
id: string //format: uuid
```

#### Responses

- 204 Deleted, or already absent.

- 400 The request failed validation, or breaks the item graph.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 409 Items still carry the tag, named by how many and the first few by short id; or other writes kept landing first, so retry.

`application/json`

```typescript
{
  error: string
}
```

## References

### #/components/securitySchemes/bearerAuth

- Type: http
- Scheme: bearer

### #/components/schemas/WorkItemView

```typescript
#/components/schemas/WorkItem & {
   // Stored on an item without children. On a parent it is derived from its open children's statuses alone, by the first of these that holds: (1) every child `done` gives `done`; (2) no child `backlog`, `ready` or `in_progress` gives `review`; (3) any child `in_progress`, `review` or `done` gives `in_progress`; (4) every child `ready` gives `ready`; (5) otherwise `backlog`. A parent whose children are all closed counts them as all `done`. So finished work beside unstarted work reads `in_progress`, a parent reads `review` only when nothing beneath it is unstarted or in progress, and `done` once everything beneath it is, with no write to it; it reads `in_progress` or `review` again as soon as a child does. An item left without children reads its stored status.
   status?: enum[backlog, ready, in_progress, review, done]
   // The shortest prefix of `id`, at least 8 characters, that starts no other item's id: what people and workers call the item. Every route taking an item's id takes this too. A new item's id is drawn so its first 8 characters start no other's, so a `shortId` once read back never comes to name a second item.
   shortId: string
   children: string[] //format: uuid
   blockedBy: string[] //format: uuid
   // `done` while some dependency of its own is neither `done` nor closed: work finished before dependencies gated the move, or given a dependency once done. Derived on read and never stored, so it clears once every dependency is `done` or closed, or the item leaves `done`.
   finishedEarly: boolean
   // The item's place in the queue, 1 for the next to start, counting the open items with a `queuedAt` whose `status` reads `backlog` or `ready`, in the order queued; null when not among them. A parent queued while its children read as started is left out until they do not. Derived on read, so it moves up as soon as an item ahead is dequeued, closed or started.
   queuePosition: integer | null //minimum: 0 //exclusiveMinimum: true
 }
```

### #/components/schemas/Tick

```typescript
{
  // The criterion's text, as it stood when ticked.
  criterion: string
  // The `claimed-by` of the write that ticked it, unverified; null when it said nothing.
  by: string | null
  // When it was ticked.
  at: string
}
```

### #/components/schemas/Assignment

```typescript
// The agent last started on the item, by `POST /items/{id}/assignment`, kept after it finishes; null when none ever was. Written by that route alone, so it is the record of who works on the item, whatever its status.
{
  // Drawn when the assignment is made; a new start on the item makes a new one.
  id: string //format: uuid
  // The agent's id in worker-service, written once worker-service has made it, or for the queue's start once it has recorded the request, whose id its agent takes; null while it is being made.
  agent: string | null //format: uuid
  // The agent's name, `<shortId>-<first 8 characters of id>`, or for the queue's start, once its request is recorded, `implementer-<first 8 characters of agent>`: who holds the item, and how a retry finds the agent already made.
  name: string
  // The `claimed-by` of the request that made it, unverified; null when it said nothing, as the person's from the page.
  by: string | null
  // When it was made.
  at: string
  // Null while the assignment stands. Set when the item is closed, or an item above it closes it, and kept on reopening: an ended assignment holds nothing, and the next start makes a new one without asking worker-service.
  ended: {
    // When it ended.
    at: string
    // Why, as the service says it: the item closed, or its agent retired.
    why: string
  }
}
```

### #/components/schemas/WorkItem

```typescript
{
  id: string //format: uuid
  type: enum[epic, story, task]
  title: string
  body: string
  acceptanceCriteria: string[]
  met: {
    // The criterion's text, as it stood when ticked.
    criterion: string
    // The `claimed-by` of the write that ticked it, unverified; null when it said nothing.
    by: string | null
    // When it was ticked.
    at: string
  }[]
  status: enum[backlog, ready, in_progress, review, done]
  // Whether anyone still needs to see the item, apart from where the work got to: `status` is never changed by closing, and reaching `done` does not close. Every item is created `open`. Closing an item closes what is open beneath it; reopening writes no other item.
  state: enum[open, closed]
  // Why a closed item closed: `completed`, or `not_planned` for work abandoned at any status. Null while open.
  closedReason: enum[completed, not_planned, ] | null
  // Required, and exactly one level up: a task's is a story, a story's is an epic. An epic's is null. A create, move or re-type that breaks this is refused with 400.
  parent: string | null //format: uuid
  dependsOn: string[] //format: uuid
  createdAt: string
  updatedAt: string
  // Who is on the item: the `claimed-by` of the write that last moved its stored `status` to `in_progress`, unverified like a history entry's `claimedBy`, and null if that write said nothing. Set by the service only. Kept through `review`; cleared by a move to `backlog`, `ready` or `done`, or by closing, and set again only by a later move to `in_progress`, so reopening alone leaves it null. A write that leaves `status` as it was leaves it as it was. Null while `status` is derived.
  heldBy: string | null
  // The reviewer that last picked the item up for review, as approval-service's reviewer `reviewer-<id>`: written only by a write's `reviewedBy`, unverified like `heldBy`. Null until one is written. Kept through every move and closing, and replaced by the next review's write, so after a send-back it names the last reviewer until a new one picks it up.
  reviewedBy: string | null
  // When the item was queued to start on its own, by a write's `queued`; null when it is not queued. Cleared in the same write that closes the item, moves its stored `status` to `in_progress`, `review` or `done`. Queuing it again keeps the time.
  queuedAt: string | null
  tags: string[] //format: uuid //maxItems: 20
  // The agent last started on the item, by `POST /items/{id}/assignment`, kept after it finishes; null when none ever was. Written by that route alone, so it is the record of who works on the item, whatever its status.
  assignment: {
    // Drawn when the assignment is made; a new start on the item makes a new one.
    id: string //format: uuid
    // The agent's id in worker-service, written once worker-service has made it, or for the queue's start once it has recorded the request, whose id its agent takes; null while it is being made.
    agent: string | null //format: uuid
    // The agent's name, `<shortId>-<first 8 characters of id>`, or for the queue's start, once its request is recorded, `implementer-<first 8 characters of agent>`: who holds the item, and how a retry finds the agent already made.
    name: string
    // The `claimed-by` of the request that made it, unverified; null when it said nothing, as the person's from the page.
    by: string | null
    // When it was made.
    at: string
    // Null while the assignment stands. Set when the item is closed, or an item above it closes it, and kept on reopening: an ended assignment holds nothing, and the next start makes a new one without asking worker-service.
    ended: {
      // When it ended.
      at: string
      // Why, as the service says it: the item closed, or its agent retired.
      why: string
    }
  }
}
```

### #/components/schemas/Error

```typescript
{
  error: string
}
```

### #/components/schemas/Conflict

```typescript
#/components/schemas/Error & {
   matches?: string[] //format: uuid
 }
```

### #/components/schemas/Blocked

```typescript
#/components/schemas/Error & {
   blockedBy: string[] //format: uuid
 }
```

### #/components/schemas/Draft

```typescript
{
  type?: enum[epic, story, task] //default: task
  title: string //minLength: 1 //maxLength: 200
  body?: string //maxLength: 20000 //default: 
  acceptanceCriteria?: string[] //minLength: 1 //maxItems: 50
  // Read back as given until the item has children. On a parent it is stored but has no effect while the parent has children, `done` included: a parent reads `done` by itself once every open child does, so there is nothing to sign off. Never changes a child. `in_progress`, `review` or `done` on a parent still reading `backlog` or `ready` is its Start: refused with 409 while its `blockedBy`, its children's blockers included, is not empty.
  status?: enum[backlog, ready, in_progress, review, done] //default: backlog
  // A story for a task, an epic for a story, null only for an epic.
  parent?: string | null //pattern: ^[0-9a-fA-F-]{8,36}$ //default: null
  // An item's id, or a prefix of it at least 8 characters long, such as its `shortId`.
  dependsOn?: string[] //pattern: ^[0-9a-fA-F-]{8,36}$ //maxItems: 50
  // Not accepted: refused with 400 whatever its value. See `WorkItem.tags`.
  tags?: any
}
```

### #/components/schemas/UpdatedItem

```typescript
#/components/schemas/WorkItemView & {
   // Present only on the person's sign-off of an epic (closing it `completed`) whose assignment names an agent: what was done to that agent. The close stands whatever it says.
   agent: {
     // The agent's id in worker-service, from the assignment.
     id: string //format: uuid
     name: string
     // `retired`: worker-service retired it now. `already_retired`: it was retired, or worker-service has no record of it, so nothing was retired. `refused`: worker-service would not retire it, in `said`.
     outcome: enum[retired, already_retired, refused]
     // The outcome in a line for the person, with worker-service's words when it refused.
     said: string
   }
 }
```

### #/components/schemas/AgentOutcome

```typescript
// Present only on the person's sign-off of an epic (closing it `completed`) whose assignment names an agent: what was done to that agent. The close stands whatever it says.
{
  // The agent's id in worker-service, from the assignment.
  id: string //format: uuid
  name: string
  // `retired`: worker-service retired it now. `already_retired`: it was retired, or worker-service has no record of it, so nothing was retired. `refused`: worker-service would not retire it, in `said`.
  outcome: enum[retired, already_retired, refused]
  // The outcome in a line for the person, with worker-service's words when it refused.
  said: string
}
```

### #/components/schemas/Patch

```typescript
{
  type?: enum[epic, story, task]
  title?: string //minLength: 1 //maxLength: 200
  body?: string //maxLength: 20000
  acceptanceCriteria?: string[] //minLength: 1 //maxItems: 50
  met?: string[] //maxItems: 50
  // Read back as given until the item has children. On a parent it is stored but has no effect while the parent has children, `done` included: a parent reads `done` by itself once every open child does, so there is nothing to sign off. Never changes a child. `in_progress`, `review` or `done` on a parent still reading `backlog` or `ready` is its Start: refused with 409 while its `blockedBy`, its children's blockers included, is not empty.
  status?: enum[backlog, ready, in_progress, review, done]
  // Closing closes everything still open beneath the item, for the same reason; reopening opens only the item, keeping its status. Closing an epic that has children as `completed` is the person's sign-off: refused with 403 from a write that sends `claimed-by`.
  state?: enum[open, closed]
  // Required with, and only with, `state: closed`.
  closedReason?: enum[completed, not_planned]
  // An item's id, or a prefix of it at least 8 characters long, such as its `shortId`.
  parent?: string | null //pattern: ^[0-9a-fA-F-]{8,36}$
  // An item's id, or a prefix of it at least 8 characters long, such as its `shortId`.
  dependsOn?: string[] //pattern: ^[0-9a-fA-F-]{8,36}$ //maxItems: 50
  // The worker reviewing the item, as the reviewer's own name; null clears it.
  reviewedBy?: string | null //minLength: 1 //maxLength: 200
  // Move the item to `in_progress`, `review` or `done` though its `blockedBy` is not empty, recorded as the history entry's `overrode`. The person's alone: refused with 403 from a write that sends `claimed-by`, as every worker's does. Changes nothing on its own.
  force?: enum[true]
  // `true` queues the item to start on its own, at the back of the queue, or keeps its place if already queued; `false` takes it off. Only an open epic, story or task that reads `backlog` or `ready` can be queued, as this write leaves it: any other is refused with 400, naming why. Recorded in `history` as a change to `queuedAt`.
  queued?: boolean
  // Not accepted: refused with 400 whatever its value. See `WorkItem.tags`.
  tags?: any
}
```

### #/components/schemas/HistoryEntry

```typescript
{
  // The item written: this one, or one beneath it when the write was made.
  item: string //format: uuid
  action: enum[created, updated, deleted]
  changes: {
    // `met` is recorded as the texts of the criteria ticked.
    field: enum[type, title, body, acceptanceCriteria, met, status, heldBy, reviewedBy, state, closedReason, parent, dependsOn, queuedAt, tags, assignment]
    // Null on `created`.
    from: Partial(string) & Partial(string[]) & Partial(boolean) & Partial(#/components/schemas/Assignment) & Partial()
    // Null on `deleted`.
    to: Partial(string) & Partial(string[]) & Partial(boolean) & Partial(#/components/schemas/Assignment) & Partial()
  }[]
  // When the service recorded it.
  at: string
  // The `claimed-by` header the write was sent with, unverified: callers sharing a token say who they are by it. Without one, the name of the write's token; null for an admin token's write that said nothing, the person's.
  claimedBy: string | null
  overrode: string[] //format: uuid
}
```

### #/components/schemas/Change

```typescript
{
  // `met` is recorded as the texts of the criteria ticked.
  field: enum[type, title, body, acceptanceCriteria, met, status, heldBy, reviewedBy, state, closedReason, parent, dependsOn, queuedAt, tags, assignment]
  // Null on `created`.
  from: Partial(string) & Partial(string[]) & Partial(boolean) & Partial(#/components/schemas/Assignment) & Partial()
  // Null on `deleted`.
  to: Partial(string) & Partial(string[]) & Partial(boolean) & Partial(#/components/schemas/Assignment) & Partial()
}
```

### #/components/schemas/Comment

```typescript
{
  id: string //format: uuid
  // The item it was written on.
  item: string //format: uuid
  // The `claimed-by` header it was written with, unverified, as a history entry's `claimedBy`. Null when the writer said nothing, as a person writing from the page does.
  author: string | null
  // When the service recorded it.
  at: string
  // Markdown.
  body: string //minLength: 1 //maxLength: 20000
}
```

### #/components/schemas/CommentDraft

```typescript
{
  // Markdown.
  body: string //minLength: 1 //maxLength: 20000
}
```

### #/components/schemas/WorkLogEntry

```typescript
#/components/schemas/Comment & {
   links: string[]
 }
```

### #/components/schemas/WorkLogDraft

```typescript
{
  // What was done, in Markdown.
  body: string //minLength: 1 //maxLength: 20000
  links?: string[] //format: uri //maxLength: 2000 //maxItems: 20
}
```

### #/components/schemas/TaggedItemView

```typescript
#/components/schemas/WorkItemView & {
   // How many items beneath this one the write changed.
   reached: integer //minimum: 0
 }
```

### #/components/schemas/ItemTag

```typescript
{
  // A tag's id, or its value in any case.
  tag: string //minLength: 1 //maxLength: 40
}
```

### #/components/schemas/Criterion

```typescript
{
  // The criterion's text, exactly as in `acceptanceCriteria`.
  criterion: string //minLength: 1
}
```

### #/components/schemas/Tag

```typescript
{
  id: string //format: uuid
  // The text shown on the chip. Unique among tags case-insensitively.
  value: string //minLength: 1 //maxLength: 40
  // The chip's background, `#rrggbb`, stored as given.
  color: string //pattern: ^#[0-9a-fA-F]{6}$
  // What the tag is for, shown when hovering its chip.
  description: string //maxLength: 500
  createdAt: string
  updatedAt: string
}
```

### #/components/schemas/TagTaken

```typescript
#/components/schemas/Error & {
   // The tag that already has the value.
   tag: string //format: uuid
 }
```

### #/components/schemas/TagDraft

```typescript
{
  // The text shown on the chip. Unique among tags case-insensitively.
  value: string //minLength: 1 //maxLength: 40
  // The chip's background, `#rrggbb`, stored as given.
  color: string //pattern: ^#[0-9a-fA-F]{6}$
  // What the tag is for, shown when hovering its chip.
  description?: string //maxLength: 500 //default: 
}
```

### #/components/schemas/TagPatch

```typescript
{
  // The text shown on the chip. Unique among tags case-insensitively.
  value?: string //minLength: 1 //maxLength: 40
  // The chip's background, `#rrggbb`, stored as given.
  color?: string //pattern: ^#[0-9a-fA-F]{6}$
  // What the tag is for, shown when hovering its chip.
  description?: string //maxLength: 500
}
```