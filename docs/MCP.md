# waypoint's MCP server

<!-- Generated from src/mcp.ts by `npm run spec`; do not edit. -->

Streamable HTTP at `/mcp`, stateless, answering JSON. Every request takes a bearer token, as the API does,
and may send `claimed-by`: each tool is one API request made with them, so it is refused, recorded and
answered as that request would be. A refusal comes back as the tool's error, with the API's status and words.

```json
{
  "mcpServers": {
    "waypoint": {
      "type": "http",
      "url": "http://127.0.0.1:4400/mcp",
      "headers": {
        "Authorization": "Bearer wp_…"
      }
    }
  }
}
```

## Instructions

What the server tells an agent when it connects:

> waypoint tracks work as epics, stories and tasks. An epic has no parent, every story has an epic, every task has a story.
>
> - A parent's status is derived from its open children: move the children, never the parent.
> - Dependencies are between siblings only. An item moves to in_progress, review or done only once blockedBy is empty.
> - Close an item (update_item with state closed and a closedReason) rather than delete it.
> - Say what you did on an item with add_work_log; talk to people about it with add_comment.
> - Every tool takes an id as the full id or a prefix of at least 8 characters, such as its shortId.

## Tools

| Tool | Does | Reads only |
| --- | --- | --- |
| [`list_items`](#list_items) | List items | yes |
| [`get_item`](#get_item) | Get an item | yes |
| [`create_item`](#create_item) | Create an item |  |
| [`update_item`](#update_item) | Update an item |  |
| [`delete_item`](#delete_item) | Delete an item |  |
| [`item_history`](#item_history) | An item's history | yes |
| [`list_comments`](#list_comments) | An item's comments | yes |
| [`add_comment`](#add_comment) | Comment on an item |  |
| [`list_work_log`](#list_work_log) | An item's work log | yes |
| [`add_work_log`](#add_work_log) | Log work on an item |  |
| [`tick_criterion`](#tick_criterion) | Tick a criterion |  |
| [`untick_criterion`](#untick_criterion) | Untick a criterion |  |
| [`list_tags`](#list_tags) | List tags | yes |
| [`create_tag`](#create_tag) | Create a tag |  |
| [`update_tag`](#update_tag) | Update a tag |  |
| [`tag_item`](#tag_item) | Tag an item |  |
| [`untag_item`](#untag_item) | Untag an item |  |
| [`get_queue`](#get_queue) | The queue | yes |
| [`start_item`](#start_item) | Start an agent on an item |  |

### list_items

Items matching every filter given, as GET /items. With no filter, every item, open and closed.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `status` | `backlog`, `ready`, `in_progress`, `review`, `done` |  |  |
| `state` | `open`, `closed` |  | `open` for only what still needs looking at. |
| `type` | `epic`, `story`, `task` |  |  |
| `parent` | string |  | Only the children of this item. |
| `heldBy` | string |  | Only items held by this name. |
| `tag` | string |  | Only items carrying this tag, by id or value. |
| `queued` | boolean |  | true: only queued items, in queue order. |

### get_item

One item, with its derived status, blockedBy and children, as GET /items/{id}.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `id` | string | yes | The item's id, or a prefix of it at least 8 characters long, such as its shortId. |

### create_item

Creates an epic, story or task, as POST /items. A story needs an epic as parent, a task a story; an epic has none.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `type` | `epic`, `story`, `task` |  |  |
| `title` | string | yes |  |
| `body` | string |  |  |
| `acceptanceCriteria` | string or object[] |  | One per criterion, each a text; they are given ids `c1`, `c2`, … in order. |
| `status` | `backlog`, `ready`, `in_progress`, `review`, `done` |  | Read back as given until the item has children. On a parent it is stored but has no effect while the parent has children, `done` included: a parent reads `done` by itself once every open child does, so there is nothing to sign off. Never changes a child. `in_progress`, `review` or `done` on a parent still reading `backlog` or `ready` is its Start: refused with 409 while its `blockedBy`, its children's blockers included, is not empty. |
| `parent` | string or null |  | A story for a task, an epic for a story, null only for an epic. |
| `dependsOn` | string[] |  |  |

### update_item

Changes the fields given in `changes`, as PATCH /items/{id}: status, title, body, criteria, parent, dependencies, queued; close it with state closed and a closedReason.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `id` | string | yes | The item's id, or a prefix of it at least 8 characters long, such as its shortId. |
| `changes` | object | yes |  |
| `changes.type` | `epic`, `story`, `task` |  |  |
| `changes.title` | string |  |  |
| `changes.body` | string |  |  |
| `changes.acceptanceCriteria` | string or object[] |  | Every criterion, in order, replacing the list. One given as `{id, text}` keeps that id, and its tick, under the text given; one given as a text keeps the id of a criterion that already reads exactly that, else gets a new id. An id the item does not have is refused with 400. |
| `changes.met` | string[] |  | Every criterion now met, each by its id or its unique text: replaces every tick held, so a tick another writer made since this one read the item is lost. To tick or untick one criterion, use POST or DELETE `/items/{id}/met`. One already ticked keeps who ticked it and when; one newly named is ticked by this write's `claimed-by`, now. Each must be one of the item's `acceptanceCriteria` as this write leaves them, or the write is refused with 400. |
| `changes.status` | `backlog`, `ready`, `in_progress`, `review`, `done` |  | Read back as given until the item has children. On a parent it is stored but has no effect while the parent has children, `done` included: a parent reads `done` by itself once every open child does, so there is nothing to sign off. Never changes a child. `in_progress`, `review` or `done` on a parent still reading `backlog` or `ready` is its Start: refused with 409 while its `blockedBy`, its children's blockers included, is not empty. |
| `changes.state` | `open`, `closed` |  | Closing closes everything still open beneath the item, for the same reason; reopening opens only the item, keeping its status. Closing an epic that has children as `completed` is the person's sign-off: refused with 403 from a write that sends `claimed-by`. |
| `changes.closedReason` | `completed`, `not_planned` |  | Required with, and only with, `state: closed`. |
| `changes.parent` | string or null |  |  |
| `changes.dependsOn` | string[] |  |  |
| `changes.reviewedBy` | string or null |  | The worker reviewing the item, as the reviewer's own name; null clears it. |
| `changes.force` | `true` |  | Move the item to `in_progress`, `review` or `done` though its `blockedBy` is not empty, recorded as the history entry's `overrode`. The person's alone: refused with 403 from a write that sends `claimed-by`, as every worker's does. Changes nothing on its own. |
| `changes.queued` | boolean |  | `true` queues the item to start on its own, at the back of the queue, or keeps its place if already queued; `false` takes it off. Only an open epic, story or task that reads `backlog` or `ready` can be queued, as this write leaves it: any other is refused with 400, naming why. Recorded in `history` as a change to `queuedAt`. |
| `changes.tags` | any |  | Not accepted: refused with 400 whatever its value. See `WorkItem.tags`. |

### delete_item

Deletes an item no other item names, as DELETE /items/{id}. Prefer closing it.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `id` | string | yes | The item's id, or a prefix of it at least 8 characters long, such as its shortId. |

### item_history

Every write to the item and beneath it, oldest first, as GET /items/{id}/history.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `id` | string | yes | The item's id, or a prefix of it at least 8 characters long, such as its shortId. |

### list_comments

What people and agents said about the item, oldest first, as GET /items/{id}/comments.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `id` | string | yes | The item's id, or a prefix of it at least 8 characters long, such as its shortId. |

### add_comment

Adds a comment to the item, as POST /items/{id}/comments.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `id` | string | yes | The item's id, or a prefix of it at least 8 characters long, such as its shortId. |
| `body` | string | yes | Markdown. |

### list_work_log

What was done on the item, oldest first, as GET /items/{id}/work-log.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `id` | string | yes | The item's id, or a prefix of it at least 8 characters long, such as its shortId. |

### add_work_log

Records what was done on the item, with links to what it made, as POST /items/{id}/work-log.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `id` | string | yes | The item's id, or a prefix of it at least 8 characters long, such as its shortId. |
| `body` | string | yes | Markdown. |
| `links` | string[] |  |  |

### tick_criterion

Marks one of the item's acceptance criteria met, by its id (c1, c2, …) or its exact text when no other reads the same, as POST /items/{id}/met.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `id` | string | yes | The item's id, or a prefix of it at least 8 characters long, such as its shortId. |
| `criterion` | string | yes | The criterion's id, as `c2`, or its text when unique. |

### untick_criterion

Marks one of the item's acceptance criteria not met, by its id or its unique text, as DELETE /items/{id}/met.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `id` | string | yes | The item's id, or a prefix of it at least 8 characters long, such as its shortId. |
| `criterion` | string | yes | The criterion's id, as `c2`, or its text when unique. |

### list_tags

Every tag: its value, colour and description, as GET /tags.

No input.

### create_tag

Adds a tag to the shared list, as POST /tags.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `value` | string | yes |  |
| `color` | string | yes |  |
| `description` | string |  | What the tag is for, shown when hovering its chip. |

### update_tag

Changes a tag's value, colour or description, as PATCH /tags/{id}.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `id` | string | yes | The tag's id. |
| `changes` | object | yes |  |
| `changes.value` | string |  |  |
| `changes.color` | string |  |  |
| `changes.description` | string |  | What the tag is for, shown when hovering its chip. |

### tag_item

Puts a tag, by id or value, on the item and everything beneath it, as POST /items/{id}/tags.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `id` | string | yes | The item's id, or a prefix of it at least 8 characters long, such as its shortId. |
| `tag` | string | yes |  |

### untag_item

Takes a tag, by id or value, off the item and everything beneath it, as DELETE /items/{id}/tags/{tag}.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `id` | string | yes | The item's id, or a prefix of it at least 8 characters long, such as its shortId. |
| `tag` | string | yes |  |

### get_queue

What the queue is running, what waits in it and why, and its running limit, as GET /queue.

No input.

### start_item

Asks the configured worker-service for an agent on the item, as POST /items/{id}/assignment; refused when none is configured.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `id` | string | yes | The item's id, or a prefix of it at least 8 characters long, such as its shortId. |
