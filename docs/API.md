# waypoint API, version 2026-11-12

A task tracker with dependency and status management. A task depends on other tasks, and the service keeps it from being started while it is blocked by one still open, or finished before its acceptance criteria are met.

- `status` is one of `backlog`, `in_progress`, `review`, `done` or `cancelled`. `done` and `cancelled` are the closed statuses.
- A task **depends on** other tasks, and is **ready** when it is in `backlog` and every task it depends on is closed.
- A task can move to `in_progress`, `review` or `done` once every task it depends on is closed, and to `done` once every criterion is met and every subtask is closed.
- A task's **subtasks** are the steps of its work, with dependencies among themselves held to the same rule. Its **criteria** are what must be true for it to be done.
- Cancelled tasks count as closed, and `ListTasks` leaves them out unless `includeCancelled` is `true` or `status` is `cancelled`.

Every request takes `Authorization: Bearer <token>` but these, which hold no data: `GetHealth` (`/health`), the contracts (`/openapi.json`, `/mcp.json`), the docs (`/docs/api`, `/docs/mcp`) and the page (`/`, `/ui/…`). A write is recorded as its `x-actor` header, else its token's name; one by the environment's admin token (`WAYPOINT_ADMIN_TOKEN`), which has no name, as null.

The API's version, 2026-11-12, is the date its contract last changed, as AWS dates theirs; the package's version is apart, and `GetHealth` gives it. Errors are `{code, message}`.

## Operations

- [ListTasks](#listtasks): List tasks
- [CreateTask](#createtask): Create a task
- [GetTask](#gettask): Get a task
- [UpdateTask](#updatetask): Update a task
- [DeleteTask](#deletetask): Delete a task
- [ListTaskHistory](#listtaskhistory): List a task's history
- [ListComments](#listcomments): List comments
- [CreateComment](#createcomment): Create a comment
- [ListLabels](#listlabels): List labels
- [CreateLabel](#createlabel): Create a label
- [GetLabel](#getlabel): Get a label
- [UpdateLabel](#updatelabel): Update a label
- [DeleteLabel](#deletelabel): Delete a label
- [GetHealth](#gethealth): Get health

## Data types

- [Task](#task)
- [Subtask](#subtask)
- [Criterion](#criterion)
- [Error](#error)
- [SubtaskInput](#subtaskinput)
- [CriterionInput](#criterioninput)
- [HistoryEntry](#historyentry)
- [Comment](#comment)
- [Label](#label)
- [Health](#health)

---

## ListTasks

Returns tasks matching every filter given, oldest first. Cancelled tasks are left out unless `status` is `cancelled` or `includeCancelled` is `true`.

### Request syntax

```http
GET /tasks?status=status&ready=ready&label=label&assignee=assignee&includeCancelled=includeCancelled&maxResults=maxResults&nextToken=nextToken HTTP/1.1
Authorization: Bearer token
```

### Query parameters

**status**  
Only tasks with this status.  
Type: String. Valid values: `backlog` | `in_progress` | `review` | `done` | `cancelled`. Required: No.

**ready**  
`true` for only tasks that can be started now; `false` for only those that can't.  
Type: String. Valid values: `true` | `false`. Required: No.

**label**  
Only tasks with this label, by ID or name.  
Type: String. Required: No.

**assignee**  
Only tasks assigned to this; `none` for only unassigned tasks.  
Type: String. Required: No.

**includeCancelled**  
`true` to include cancelled tasks.  
Type: String. Valid values: `true` | `false`. Required: No.

**maxResults**  
The most results to return. Default 100.  
Type: Integer. Range: 1 to 500. Required: No.

**nextToken**  
The `nextToken` from the previous page.  
Type: String. Required: No.

### Response syntax

```http
HTTP/1.1 200
Content-type: application/json

{
   "tasks": [ {
      "id": "string",
      "shortId": "string",
      "title": "string",
      "description": "string",
      "status": "backlog | in_progress | review | done | cancelled",
      "dependsOn": [ "string" ],
      "subtasks": [ {
         "id": "string",
         "title": "string",
         "description": "string",
         "status": "backlog | in_progress | review | done | cancelled",
         "dependsOn": [ "string" ],
         "blockedBy": [ "string" ]
      } ],
      "criteria": [ {
         "id": "string",
         "text": "string",
         "met": boolean,
         "metBy": "string",
         "metAt": "string"
      } ],
      "labels": [ "string" ],
      "assignee": "string",
      "createdAt": "string",
      "updatedAt": "string",
      "blockedBy": [ "string" ],
      "ready": boolean
   } ],
   "nextToken": "string"
}
```

### Response elements

**tasks**  
The tasks.  
Type: Array of [Task](#task) objects.

**nextToken**  
The token for the next page, or null on the last.  
Type: String. Nullable: Yes.

### Errors

**ValidationException**  
A field is missing, malformed or out of bounds; `message` says which.  
HTTP status: 400

**UnauthorizedException**  
The `Authorization` header is missing, or its token isn't one this service issued.  
HTTP status: 401

---

## CreateTask

Creates a task in `backlog`, unless `status` says otherwise. A status past `backlog` is held to the same rules as `UpdateTask`.

### Request syntax

```http
POST /tasks HTTP/1.1
Authorization: Bearer token
x-actor: string
Content-type: application/json

{
   "title": "string",
   "description": "string",
   "status": "backlog | in_progress | review | done | cancelled",
   "dependsOn": [ "string" ],
   "subtasks": [ {
      "id": "string",
      "title": "string",
      "description": "string",
      "status": "backlog | in_progress | review | done | cancelled",
      "dependsOn": [ "string" ]
   } ],
   "criteria": [ {
      "id": "string",
      "text": "string",
      "met": boolean
   } ],
   "labels": [ "string" ],
   "assignee": "string",
   "clientToken": "string"
}
```

### Request headers

**x-actor**  
Who is making the write, recorded in history in place of the token's name. For a token several callers share.  
Type: String. Length: 0 to 200. Required: No.

### Request body

**title**  
A short name for the task.  
Type: String. Length: 1 to 200. Required: Yes.

**description**  
What the task is, in Markdown.  
Type: String. Length: 0 to 20000. Required: No.

**status**  
Where it stands. `done` and `cancelled` are the closed statuses.  
Type: String. Valid values: `backlog` | `in_progress` | `review` | `done` | `cancelled`. Required: No.

**dependsOn**  
The IDs of the tasks this one depends on.  
Type: Array of strings. At most 50 items. Required: No.

**subtasks**  
The steps of the work, in order. On update this is the whole list: a subtask left out is removed.  
Type: Array of [SubtaskInput](#subtaskinput) objects. At most 50 items. Required: No.

**criteria**  
The acceptance criteria, in order. On update this is the whole list: a criterion left out is removed.  
Type: Array of [CriterionInput](#criterioninput) objects. At most 50 items. Required: No.

**labels**  
Labels, each by ID or name.  
Type: Array of strings. At most 20 items. Required: No.

**assignee**  
Who the task is assigned to; null for no one.  
Type: String. Length: 1 to 200. Nullable: Yes. Required: No.

**clientToken**  
A unique string you choose. Retrying a request with the same token returns what the first created, instead of creating another.  
Type: String. Length: 1 to 64. Required: No.

### Response syntax

```http
HTTP/1.1 201
Content-type: application/json

{
   "task": {
      "id": "string",
      "shortId": "string",
      "title": "string",
      "description": "string",
      "status": "backlog | in_progress | review | done | cancelled",
      "dependsOn": [ "string" ],
      "subtasks": [ {
         "id": "string",
         "title": "string",
         "description": "string",
         "status": "backlog | in_progress | review | done | cancelled",
         "dependsOn": [ "string" ],
         "blockedBy": [ "string" ]
      } ],
      "criteria": [ {
         "id": "string",
         "text": "string",
         "met": boolean,
         "metBy": "string",
         "metAt": "string"
      } ],
      "labels": [ "string" ],
      "assignee": "string",
      "createdAt": "string",
      "updatedAt": "string",
      "blockedBy": [ "string" ],
      "ready": boolean
   }
}
```

### Response elements

**task**  
Type: [Task](#task) object.

### Errors

**ValidationException**  
A field is missing, malformed or out of bounds; `message` says which. Also: a dependency cycle, among tasks or among its subtasks.  
HTTP status: 400

**UnauthorizedException**  
The `Authorization` header is missing, or its token isn't one this service issued.  
HTTP status: 401

**ResourceNotFoundException**  
A task or label named in the body doesn't exist.  
HTTP status: 404

**ConflictException**  
The status given is refused: see `UpdateTask`.  
HTTP status: 409

---

## GetTask

Get a task.

### Request syntax

```http
GET /tasks/{taskId} HTTP/1.1
Authorization: Bearer token
```

### URI request parameters

**taskId**  
The task's ID, or a prefix of it at least 8 characters long, such as its `shortId`.  
Type: String. Minimum length: 8. Required: Yes.

### Response syntax

```http
HTTP/1.1 200
Content-type: application/json

{
   "task": {
      "id": "string",
      "shortId": "string",
      "title": "string",
      "description": "string",
      "status": "backlog | in_progress | review | done | cancelled",
      "dependsOn": [ "string" ],
      "subtasks": [ {
         "id": "string",
         "title": "string",
         "description": "string",
         "status": "backlog | in_progress | review | done | cancelled",
         "dependsOn": [ "string" ],
         "blockedBy": [ "string" ]
      } ],
      "criteria": [ {
         "id": "string",
         "text": "string",
         "met": boolean,
         "metBy": "string",
         "metAt": "string"
      } ],
      "labels": [ "string" ],
      "assignee": "string",
      "createdAt": "string",
      "updatedAt": "string",
      "blockedBy": [ "string" ],
      "ready": boolean
   }
}
```

### Response elements

**task**  
Type: [Task](#task) object.

### Errors

**UnauthorizedException**  
The `Authorization` header is missing, or its token isn't one this service issued.  
HTTP status: 401

**ResourceNotFoundException**  
No task has that ID.  
HTTP status: 404

**ConflictException**  
The short ID matches more than one task; `matches` lists them.  
HTTP status: 409

---

## UpdateTask

Changes the fields given. In `criteria` and `subtasks`, a field left out of an entry keeps its value as it stands when the write lands: to mark one criterion met, send `met: true` on that entry only. Cancelling a task cancels its open subtasks.

### Request syntax

```http
PATCH /tasks/{taskId} HTTP/1.1
Authorization: Bearer token
x-actor: string
Content-type: application/json

{
   "title": "string",
   "description": "string",
   "status": "backlog | in_progress | review | done | cancelled",
   "dependsOn": [ "string" ],
   "subtasks": [ {
      "id": "string",
      "title": "string",
      "description": "string",
      "status": "backlog | in_progress | review | done | cancelled",
      "dependsOn": [ "string" ]
   } ],
   "criteria": [ {
      "id": "string",
      "text": "string",
      "met": boolean
   } ],
   "labels": [ "string" ],
   "assignee": "string"
}
```

### URI request parameters

**taskId**  
The task's ID, or a prefix of it at least 8 characters long, such as its `shortId`.  
Type: String. Minimum length: 8. Required: Yes.

### Request headers

**x-actor**  
Who is making the write, recorded in history in place of the token's name. For a token several callers share.  
Type: String. Length: 0 to 200. Required: No.

### Request body

**title**  
A short name for the task.  
Type: String. Length: 1 to 200. Required: No.

**description**  
What the task is, in Markdown.  
Type: String. Length: 0 to 20000. Required: No.

**status**  
Where it stands. `done` and `cancelled` are the closed statuses.  
Type: String. Valid values: `backlog` | `in_progress` | `review` | `done` | `cancelled`. Required: No.

**dependsOn**  
The IDs of the tasks this one depends on.  
Type: Array of strings. At most 50 items. Required: No.

**subtasks**  
The steps of the work, in order. On update this is the whole list: a subtask left out is removed.  
Type: Array of [SubtaskInput](#subtaskinput) objects. At most 50 items. Required: No.

**criteria**  
The acceptance criteria, in order. On update this is the whole list: a criterion left out is removed.  
Type: Array of [CriterionInput](#criterioninput) objects. At most 50 items. Required: No.

**labels**  
Labels, each by ID or name.  
Type: Array of strings. At most 20 items. Required: No.

**assignee**  
Who the task is assigned to; null for no one.  
Type: String. Length: 1 to 200. Nullable: Yes. Required: No.

### Response syntax

```http
HTTP/1.1 200
Content-type: application/json

{
   "task": {
      "id": "string",
      "shortId": "string",
      "title": "string",
      "description": "string",
      "status": "backlog | in_progress | review | done | cancelled",
      "dependsOn": [ "string" ],
      "subtasks": [ {
         "id": "string",
         "title": "string",
         "description": "string",
         "status": "backlog | in_progress | review | done | cancelled",
         "dependsOn": [ "string" ],
         "blockedBy": [ "string" ]
      } ],
      "criteria": [ {
         "id": "string",
         "text": "string",
         "met": boolean,
         "metBy": "string",
         "metAt": "string"
      } ],
      "labels": [ "string" ],
      "assignee": "string",
      "createdAt": "string",
      "updatedAt": "string",
      "blockedBy": [ "string" ],
      "ready": boolean
   }
}
```

### Response elements

**task**  
Type: [Task](#task) object.

### Errors

**ValidationException**  
A field is missing, malformed or out of bounds; `message` says which. Also: a dependency cycle, among tasks or among its subtasks, or a criterion or subtask ID the task doesn't have.  
HTTP status: 400

**UnauthorizedException**  
The `Authorization` header is missing, or its token isn't one this service issued.  
HTTP status: 401

**ResourceNotFoundException**  
No task has that ID, or a task or label named in the body doesn't exist.  
HTTP status: 404

**ConflictException**  
Moving the task, or a subtask, to `in_progress`, `review` or `done` while its `blockedBy` isn't empty; moving the task to `done` while a criterion is unmet (`unmetCriteria`) or a subtask is open (`openSubtasks`). Or: The short ID matches more than one task; `matches` lists them.  
HTTP status: 409

---

## DeleteTask

Deletes a task no other task depends on. To close a task instead, set its status to `cancelled`.

### Request syntax

```http
DELETE /tasks/{taskId} HTTP/1.1
Authorization: Bearer token
x-actor: string
```

### URI request parameters

**taskId**  
The task's ID, or a prefix of it at least 8 characters long, such as its `shortId`.  
Type: String. Minimum length: 8. Required: Yes.

### Request headers

**x-actor**  
Who is making the write, recorded in history in place of the token's name. For a token several callers share.  
Type: String. Length: 0 to 200. Required: No.

### Response syntax

```http
HTTP/1.1 204
```

### Errors

**UnauthorizedException**  
The `Authorization` header is missing, or its token isn't one this service issued.  
HTTP status: 401

**ResourceNotFoundException**  
No task has that ID.  
HTTP status: 404

**ConflictException**  
Another task depends on it. Or: The short ID matches more than one task; `matches` lists them.  
HTTP status: 409

---

## ListTaskHistory

Returns every write to the task, oldest first.

### Request syntax

```http
GET /tasks/{taskId}/history?maxResults=maxResults&nextToken=nextToken HTTP/1.1
Authorization: Bearer token
```

### URI request parameters

**taskId**  
The task's ID, or a prefix of it at least 8 characters long, such as its `shortId`.  
Type: String. Minimum length: 8. Required: Yes.

### Query parameters

**maxResults**  
The most results to return. Default 100.  
Type: Integer. Range: 1 to 500. Required: No.

**nextToken**  
The `nextToken` from the previous page.  
Type: String. Required: No.

### Response syntax

```http
HTTP/1.1 200
Content-type: application/json

{
   "entries": [ {
      "taskId": "string",
      "action": "created | updated | deleted",
      "changes": [ {
         "field": "string",
         "from": value,
         "to": value
      } ],
      "actor": "string",
      "at": "string"
   } ],
   "nextToken": "string"
}
```

### Response elements

**entries**  
The writes.  
Type: Array of [HistoryEntry](#historyentry) objects.

**nextToken**  
The token for the next page, or null on the last.  
Type: String. Nullable: Yes.

### Errors

**ValidationException**  
A field is missing, malformed or out of bounds; `message` says which.  
HTTP status: 400

**UnauthorizedException**  
The `Authorization` header is missing, or its token isn't one this service issued.  
HTTP status: 401

**ResourceNotFoundException**  
No task has that ID.  
HTTP status: 404

**ConflictException**  
The short ID matches more than one task; `matches` lists them.  
HTTP status: 409

---

## ListComments

Returns a task's comments, oldest first.

### Request syntax

```http
GET /tasks/{taskId}/comments?maxResults=maxResults&nextToken=nextToken HTTP/1.1
Authorization: Bearer token
```

### URI request parameters

**taskId**  
The task's ID, or a prefix of it at least 8 characters long, such as its `shortId`.  
Type: String. Minimum length: 8. Required: Yes.

### Query parameters

**maxResults**  
The most results to return. Default 100.  
Type: Integer. Range: 1 to 500. Required: No.

**nextToken**  
The `nextToken` from the previous page.  
Type: String. Required: No.

### Response syntax

```http
HTTP/1.1 200
Content-type: application/json

{
   "comments": [ {
      "id": "string",
      "taskId": "string",
      "author": "string",
      "body": "string",
      "createdAt": "string"
   } ],
   "nextToken": "string"
}
```

### Response elements

**comments**  
The comments.  
Type: Array of [Comment](#comment) objects.

**nextToken**  
The token for the next page, or null on the last.  
Type: String. Nullable: Yes.

### Errors

**ValidationException**  
A field is missing, malformed or out of bounds; `message` says which.  
HTTP status: 400

**UnauthorizedException**  
The `Authorization` header is missing, or its token isn't one this service issued.  
HTTP status: 401

**ResourceNotFoundException**  
No task has that ID.  
HTTP status: 404

**ConflictException**  
The short ID matches more than one task; `matches` lists them.  
HTTP status: 409

---

## CreateComment

Adds a comment to a task. A comment changes none of the task's fields.

### Request syntax

```http
POST /tasks/{taskId}/comments HTTP/1.1
Authorization: Bearer token
x-actor: string
Content-type: application/json

{
   "body": "string",
   "clientToken": "string"
}
```

### URI request parameters

**taskId**  
The task's ID, or a prefix of it at least 8 characters long, such as its `shortId`.  
Type: String. Minimum length: 8. Required: Yes.

### Request headers

**x-actor**  
Who is making the write, recorded in history in place of the token's name. For a token several callers share.  
Type: String. Length: 0 to 200. Required: No.

### Request body

**body**  
The comment, in Markdown.  
Type: String. Length: 1 to 20000. Required: Yes.

**clientToken**  
A unique string you choose. Retrying a request with the same token returns what the first created, instead of creating another.  
Type: String. Length: 1 to 64. Required: No.

### Response syntax

```http
HTTP/1.1 201
Content-type: application/json

{
   "comment": {
      "id": "string",
      "taskId": "string",
      "author": "string",
      "body": "string",
      "createdAt": "string"
   }
}
```

### Response elements

**comment**  
Type: [Comment](#comment) object.

### Errors

**ValidationException**  
A field is missing, malformed or out of bounds; `message` says which.  
HTTP status: 400

**UnauthorizedException**  
The `Authorization` header is missing, or its token isn't one this service issued.  
HTTP status: 401

**ResourceNotFoundException**  
No task has that ID.  
HTTP status: 404

**ConflictException**  
The short ID matches more than one task; `matches` lists them.  
HTTP status: 409

---

## ListLabels

Returns labels by name.

### Request syntax

```http
GET /labels?maxResults=maxResults&nextToken=nextToken HTTP/1.1
Authorization: Bearer token
```

### Query parameters

**maxResults**  
The most results to return. Default 100.  
Type: Integer. Range: 1 to 500. Required: No.

**nextToken**  
The `nextToken` from the previous page.  
Type: String. Required: No.

### Response syntax

```http
HTTP/1.1 200
Content-type: application/json

{
   "labels": [ {
      "id": "string",
      "name": "string",
      "color": "string",
      "description": "string",
      "createdAt": "string",
      "updatedAt": "string"
   } ],
   "nextToken": "string"
}
```

### Response elements

**labels**  
The labels.  
Type: Array of [Label](#label) objects.

**nextToken**  
The token for the next page, or null on the last.  
Type: String. Nullable: Yes.

### Errors

**ValidationException**  
A field is missing, malformed or out of bounds; `message` says which.  
HTTP status: 400

**UnauthorizedException**  
The `Authorization` header is missing, or its token isn't one this service issued.  
HTTP status: 401

---

## CreateLabel

Create a label.

### Request syntax

```http
POST /labels HTTP/1.1
Authorization: Bearer token
Content-type: application/json

{
   "name": "string",
   "color": "string",
   "description": "string",
   "clientToken": "string"
}
```

### Request body

**name**  
The label's name, unique ignoring case.  
Type: String. Length: 1 to 40. Required: Yes.

**color**  
Its colour, as `#rrggbb`. Default `#808080`.  
Type: String. Pattern: `^#[0-9a-fA-F]{6}$`. Required: No.

**description**  
What the label is for.  
Type: String. Length: 0 to 500. Required: No.

**clientToken**  
A unique string you choose. Retrying a request with the same token returns what the first created, instead of creating another.  
Type: String. Length: 1 to 64. Required: No.

### Response syntax

```http
HTTP/1.1 201
Content-type: application/json

{
   "label": {
      "id": "string",
      "name": "string",
      "color": "string",
      "description": "string",
      "createdAt": "string",
      "updatedAt": "string"
   }
}
```

### Response elements

**label**  
Type: [Label](#label) object.

### Errors

**ValidationException**  
A field is missing, malformed or out of bounds; `message` says which.  
HTTP status: 400

**UnauthorizedException**  
The `Authorization` header is missing, or its token isn't one this service issued.  
HTTP status: 401

**ConflictException**  
Another label has that name.  
HTTP status: 409

---

## GetLabel

Get a label.

### Request syntax

```http
GET /labels/{labelId} HTTP/1.1
Authorization: Bearer token
```

### URI request parameters

**labelId**  
The label's ID or name.  
Type: String. Required: Yes.

### Response syntax

```http
HTTP/1.1 200
Content-type: application/json

{
   "label": {
      "id": "string",
      "name": "string",
      "color": "string",
      "description": "string",
      "createdAt": "string",
      "updatedAt": "string"
   }
}
```

### Response elements

**label**  
Type: [Label](#label) object.

### Errors

**UnauthorizedException**  
The `Authorization` header is missing, or its token isn't one this service issued.  
HTTP status: 401

**ResourceNotFoundException**  
No label has that ID or name.  
HTTP status: 404

---

## UpdateLabel

Changes the fields given.

### Request syntax

```http
PATCH /labels/{labelId} HTTP/1.1
Authorization: Bearer token
Content-type: application/json

{
   "name": "string",
   "color": "string",
   "description": "string"
}
```

### URI request parameters

**labelId**  
The label's ID or name.  
Type: String. Required: Yes.

### Request body

**name**  
The label's name, unique ignoring case.  
Type: String. Length: 1 to 40. Required: No.

**color**  
Its colour, as `#rrggbb`. Default `#808080`.  
Type: String. Pattern: `^#[0-9a-fA-F]{6}$`. Required: No.

**description**  
What the label is for.  
Type: String. Length: 0 to 500. Required: No.

### Response syntax

```http
HTTP/1.1 200
Content-type: application/json

{
   "label": {
      "id": "string",
      "name": "string",
      "color": "string",
      "description": "string",
      "createdAt": "string",
      "updatedAt": "string"
   }
}
```

### Response elements

**label**  
Type: [Label](#label) object.

### Errors

**ValidationException**  
A field is missing, malformed or out of bounds; `message` says which.  
HTTP status: 400

**UnauthorizedException**  
The `Authorization` header is missing, or its token isn't one this service issued.  
HTTP status: 401

**ResourceNotFoundException**  
No label has that ID or name.  
HTTP status: 404

**ConflictException**  
Another label has that name.  
HTTP status: 409

---

## DeleteLabel

Deletes a label and removes it from every task that has it.

### Request syntax

```http
DELETE /labels/{labelId} HTTP/1.1
Authorization: Bearer token
```

### URI request parameters

**labelId**  
The label's ID or name.  
Type: String. Required: Yes.

### Response syntax

```http
HTTP/1.1 204
```

### Errors

**UnauthorizedException**  
The `Authorization` header is missing, or its token isn't one this service issued.  
HTTP status: 401

**ResourceNotFoundException**  
No label has that ID or name.  
HTTP status: 404

---

## GetHealth

Reports that the service is up, and which build it runs. Needs no token.

### Request syntax

```http
GET /health HTTP/1.1
```

### Response syntax

```http
HTTP/1.1 200
Content-type: application/json

{
   "ok": "true",
   "version": "string",
   "commit": "string"
}
```

### Response elements

**ok**  
Always true: an answer means the service is up.  
Type: Boolean.

**version**  
The package version.  
Type: String.

**commit**  
The git commit it was built from.  
Type: String.

---

# Data types

## Task

### Contents

**id**  
The task's ID, a UUID.  
Type: String. Required: Yes.

**shortId**  
The shortest prefix of `id`, at least 8 characters, that no other task's ID starts with. Accepted wherever an ID is.  
Type: String. Required: Yes.

**title**  
A short name for the task.  
Type: String. Required: Yes.

**description**  
What the task is, in Markdown.  
Type: String. Required: Yes.

**status**  
Where it stands. `done` and `cancelled` are the closed statuses.  
Type: String. Valid values: `backlog` | `in_progress` | `review` | `done` | `cancelled`. Required: Yes.

**dependsOn**  
The IDs of the tasks this one depends on.  
Type: Array of strings. Required: Yes.

**subtasks**  
The steps of the work, in order. The task can't be `done` until each is closed.  
Type: Array of [Subtask](#subtask) objects. Required: Yes.

**criteria**  
The acceptance criteria, in order. The task can't be `done` until each is met.  
Type: Array of [Criterion](#criterion) objects. Required: Yes.

**labels**  
The IDs of its labels.  
Type: Array of strings. Required: Yes.

**assignee**  
Who the task is assigned to, as free text; null if no one.  
Type: String. Nullable: Yes. Required: Yes.

**createdAt**  
When, as an ISO 8601 date and time in UTC.  
Type: String. Required: Yes.

**updatedAt**  
When, as an ISO 8601 date and time in UTC.  
Type: String. Required: Yes.

**blockedBy**  
The tasks in `dependsOn` that aren't closed yet.  
Type: Array of strings. Required: Yes.

**ready**  
Whether it can be started now: in `backlog`, with nothing in `blockedBy`.  
Type: Boolean. Required: Yes.

## Subtask

### Contents

**id**  
The subtask's ID within its task: `s1`, `s2`, and so on. Kept for as long as the subtask is.  
Type: String. Required: Yes.

**title**  
A short name for the step.  
Type: String. Required: Yes.

**description**  
What the step is, in Markdown.  
Type: String. Required: Yes.

**status**  
Where it stands. `done` and `cancelled` are the closed statuses.  
Type: String. Valid values: `backlog` | `in_progress` | `review` | `done` | `cancelled`. Required: Yes.

**dependsOn**  
The IDs of the subtasks of the same task this one depends on.  
Type: Array of strings. Required: Yes.

**blockedBy**  
The subtasks in `dependsOn` that aren't closed yet.  
Type: Array of strings. Required: Yes.

## Criterion

### Contents

**id**  
The criterion's ID within its task: `c1`, `c2`, and so on. Kept for as long as the criterion is.  
Type: String. Required: Yes.

**text**  
What must be true.  
Type: String. Required: Yes.

**met**  
Whether it has been marked met.  
Type: Boolean. Required: Yes.

**metBy**  
Who marked it met; null while it isn't.  
Type: String. Nullable: Yes. Required: Yes.

**metAt**  
When it was marked met; null while it isn't.  
Type: String. Nullable: Yes. Required: Yes.

## Error

### Contents

**code**  
What kind of error it is.  
Type: String. Valid values: `ValidationException` | `UnauthorizedException` | `ResourceNotFoundException` | `ConflictException` | `InternalServerException`. Required: Yes.

**message**  
What went wrong.  
Type: String. Required: Yes.

**blockedBy**  
The open tasks, or subtasks, it is blocked by.  
Type: Array of strings. Required: No.

**unmetCriteria**  
The criteria not yet met.  
Type: Array of strings. Required: No.

**openSubtasks**  
The IDs of the subtasks not yet closed.  
Type: Array of strings. Required: No.

**matches**  
The task IDs a short ID matches.  
Type: Array of strings. Required: No.

## SubtaskInput

### Contents

**id**  
The ID of an existing subtask. Omit it for a new one.  
Type: String. Required: No.

**title**  
A short name for the step. Required for a new subtask.  
Type: String. Length: 1 to 200. Required: No.

**description**  
What the step is, in Markdown.  
Type: String. Length: 0 to 20000. Required: No.

**status**  
Where the step stands. Omit it to leave it as it stands when the write lands; a new subtask starts in `backlog`.  
Type: String. Valid values: `backlog` | `in_progress` | `review` | `done` | `cancelled`. Required: No.

**dependsOn**  
The IDs of subtasks of the same task this one depends on.  
Type: Array of strings. At most 50 items. Required: No.

## CriterionInput

### Contents

**id**  
The ID of an existing criterion. Omit it for a new one.  
Type: String. Required: No.

**text**  
What must be true. Required for a new criterion.  
Type: String. Length: 1 to 500. Required: No.

**met**  
Whether it is met. Omit it to leave it as it stands when the write lands.  
Type: Boolean. Required: No.

## HistoryEntry

### Contents

**taskId**  
The task written.  
Type: String. Required: Yes.

**action**  
What the write did.  
Type: String. Valid values: `created` | `updated` | `deleted`. Required: Yes.

**changes**  
Each field the write changed.  
Type: Array of Object. Required: Yes.

**actor**  
Who made the write: its `x-actor` header, else the name of its token. Null for an admin token that named no one.  
Type: String. Nullable: Yes. Required: Yes.

**at**  
When, as an ISO 8601 date and time in UTC.  
Type: String. Required: Yes.

## Comment

### Contents

**id**  
The comment's ID.  
Type: String. Required: Yes.

**taskId**  
The task it is on.  
Type: String. Required: Yes.

**author**  
Who wrote it: its `x-actor` header, else the name of its token.  
Type: String. Nullable: Yes. Required: Yes.

**body**  
The comment, in Markdown.  
Type: String. Required: Yes.

**createdAt**  
When, as an ISO 8601 date and time in UTC.  
Type: String. Required: Yes.

## Label

### Contents

**id**  
The label's ID.  
Type: String. Required: Yes.

**name**  
The label's name, unique ignoring case.  
Type: String. Required: Yes.

**color**  
Its colour, as `#rrggbb`.  
Type: String. Required: Yes.

**description**  
What the label is for.  
Type: String. Required: Yes.

**createdAt**  
When, as an ISO 8601 date and time in UTC.  
Type: String. Required: Yes.

**updatedAt**  
When, as an ISO 8601 date and time in UTC.  
Type: String. Required: Yes.

## Health

### Contents

**ok**  
Always true: an answer means the service is up.  
Type: Boolean. Required: Yes.

**version**  
The package version.  
Type: String. Required: Yes.

**commit**  
The git commit it was built from.  
Type: String. Required: Yes.

