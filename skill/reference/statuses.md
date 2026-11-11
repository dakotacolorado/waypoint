# Status, state and dependencies

## Status: the board's columns

`backlog` → `ready` → `in_progress` → `review` → `done`

An item **without children** reads back the status it was given; set it as
the work moves.

An item **with children** (any epic or story with items under it) has its
status **derived** from its open children, by the first rule that holds:

1. Every child `done` → `done`.
2. No child `backlog`, `ready` or `in_progress` → `review`.
3. Any child `in_progress`, `review` or `done` → `in_progress`.
4. Every child `ready` → `ready`.
5. Otherwise → `backlog`.

Closed children count as `done`. An item without children reads its stored
status again.

So on a parent, writing a status does nothing, `done` included: a parent reads
`done` by itself once its children do, with no sign-off, and reads
`in_progress` or `review` again as soon as a child does. Move the children; the
parent follows.

## State: open or closed

Separate from status. Every item starts `open`. Close one, at any status, with:

```json
{ "state": "closed", "closedReason": "completed" }
{ "state": "closed", "closedReason": "not_planned" }
```

An epic that has children is closed `completed` by the person alone, from its
review panel: a write with your name is refused with 403. When its work is all
done, page `waiting` naming the epic instead. Closing one `not_planned`, or a
childless epic, is not refused.

`closedReason` goes with `state: closed`, and only with it. Reopen with
`{"state":"open"}`; the item keeps the status it had. Reaching `done` does not
close an item, and closing does not change its status.

## Dependencies

`dependsOn` lists items that must reach `done` first. **Dependencies are
between siblings only**: an item depends on items of its own type with the
same parent, so epics on epics, a story on stories in its own epic, a task on
tasks in its own story. A create or update adding any other is refused with
400 naming it. When a story needs a story in another epic, its epic depends on
that epic instead (see [conventions.md](conventions.md)). A move to another
parent is refused with 400 while the item has dependencies, or open items
depend on it, naming them: remove those first. Dependencies stored before the
rule are kept as they are.

They gate
the work: a move to `in_progress`, `review` or `done`, by create or update, or
a move under a new parent while at one of those, is refused with 409 while
`blockedBy` is not empty. The refusal's `error` names each dependency with its
short id, title and status, and its `blockedBy` lists their ids: wait until
those are `done` (or closed), don't work around them. A move back to `backlog`
or `ready` is never refused, and work already started when a dependency is
added keeps its status: only its next move is checked. Statuses are read as
served, so a parent's is its derived one: depending on a parent waits until
every child of it is `done` or closed. A parent moves only with its children,
so each child's move is checked against what every item above it depends on.

- **`blockedBy`** lists, at every status, each dependency of the item, of
  any item above it, or of any open item below it not yet `done`, that is
  open and does not read `done`. A dependency between items in the item's own
  subtree is left out: that is work it does. So a parent reads blocked for the
  same reasons its children do, and writing it `in_progress`, `review` or
  `done` while it reads `backlog` or `ready`, its Start, is refused the same
  way. A dependency in
  `review` still holds it. A closed one, for either reason, does not, until it
  is reopened. A `ready` item with an empty `blockedBy` can be started now.
- **Override**: the person, and only the person, can move an item past its
  `blockedBy` with `"force": true` on the PATCH. It is accepted only from a
  write with no `claimed-by`, as the page's; `wt` sends yours, so a worker's
  is refused with 403. The history entry's `overrode` lists what it moved past.
- **`finishedEarly`** is true while the item reads `done` and some dependency
  of its own is open and not `done`: work finished before the gate, by
  override, or given the dependency after. It clears once every dependency is
  `done` or closed, or the item leaves `done`. It is computed on read, never
  stored.
