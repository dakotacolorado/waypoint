# waypoint's MCP server

<!-- Generated from src/mcp.ts by `npm run spec`; do not edit. -->

Streamable HTTP at `/mcp`, stateless, answering JSON. Every request takes a bearer token, as the API does,
and may send `x-actor`: each tool is one API request made with them, so it is refused, recorded and
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

> waypoint: A task tracker with dependency and status management.
>
> - status is backlog, in_progress, review, done or cancelled; done and cancelled are the closed statuses.
> - A task depends on the tasks in its dependsOn, and is blocked by those still open (blockedBy). It is ready when it is in backlog and every task it depends on is closed.
> - A task can move to in_progress, review or done once every task it depends on is closed, and to done once every criterion is met and every subtask is closed. Subtasks follow the same rule among themselves.
> - In update_task, criteria and subtasks are whole lists matched by id; a field left out of an entry keeps its value. To mark one criterion met, send met: true on that entry only.
> - A task ID may be given as its shortId.

## Tools

| Tool | Does | Reads only |
| --- | --- | --- |
| [`list_tasks`](#list_tasks) | List tasks | yes |
| [`create_task`](#create_task) | Create a task |  |
| [`get_task`](#get_task) | Get a task | yes |
| [`update_task`](#update_task) | Update a task |  |
| [`delete_task`](#delete_task) | Delete a task |  |
| [`list_task_history`](#list_task_history) | List a task's history | yes |
| [`list_comments`](#list_comments) | List comments | yes |
| [`create_comment`](#create_comment) | Create a comment |  |
| [`list_labels`](#list_labels) | List labels | yes |
| [`create_label`](#create_label) | Create a label |  |
| [`get_label`](#get_label) | Get a label | yes |
| [`update_label`](#update_label) | Update a label |  |
| [`delete_label`](#delete_label) | Delete a label |  |

### list_tasks

Returns tasks matching every filter given, oldest first. Cancelled tasks are left out unless status is cancelled or includeCancelled is true.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `status` | `backlog`, `in_progress`, `review`, `done`, `cancelled` |  | Only tasks with this status. |
| `ready` | boolean |  | true for only tasks that can be started now. |
| `label` | string |  | Only tasks with this label, by ID or name. |
| `assignee` | string |  | Only tasks assigned to this; none for unassigned tasks. |
| `dependsOn` | string |  | Only tasks that depend on this task, by its ID or a prefix of it at least 8 characters long. |
| `q` | string |  | Only tasks whose title or description contains this text, ignoring case. |
| `includeCancelled` | boolean |  | true to include cancelled tasks. |
| `maxResults` | integer |  | The most results to return. Default 100. |
| `nextToken` | string |  | The nextToken from the previous page. |

### create_task

Creates a task in backlog, unless status says otherwise.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `title` | string | yes | A short name for the task. |
| `description` | string |  | What the task is, in Markdown. |
| `status` | `backlog`, `in_progress`, `review`, `done`, `cancelled` |  | Where it stands. `done` and `cancelled` are the closed statuses. |
| `dependsOn` | string[] |  | The IDs of the tasks this one depends on. |
| `subtasks` | object[] |  | The steps of the work, in order. On update this is the whole list: a subtask left out is removed. |
| `criteria` | object[] |  | The acceptance criteria, in order. On update this is the whole list: a criterion left out is removed. |
| `labels` | string[] |  | Labels, each by ID or name. |
| `assignee` | string or null |  | Who the task is assigned to; null for no one. |
| `verification` | object or null |  | Who checks the task's work and when; null to say nothing of it. |
| `clientToken` | string |  | A unique string; retrying with it returns what the first request created. |

### get_task

Returns a task.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `taskId` | string | yes | The task's ID, or a prefix of it at least 8 characters long, such as its shortId. |

### update_task

Changes the fields given. Cancelling a task cancels its open subtasks.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `taskId` | string | yes | The task's ID, or a prefix of it at least 8 characters long, such as its shortId. |
| `title` | string |  | A short name for the task. |
| `description` | string |  | What the task is, in Markdown. |
| `status` | `backlog`, `in_progress`, `review`, `done`, `cancelled` |  | Where it stands. `done` and `cancelled` are the closed statuses. |
| `dependsOn` | string[] |  | The IDs of the tasks this one depends on. |
| `subtasks` | object[] |  | The steps of the work, in order. On update this is the whole list: a subtask left out is removed. |
| `criteria` | object[] |  | The acceptance criteria, in order. On update this is the whole list: a criterion left out is removed. |
| `labels` | string[] |  | Labels, each by ID or name. |
| `assignee` | string or null |  | Who the task is assigned to; null for no one. |
| `verification` | object or null |  | Who checks the task's work and when; null to say nothing of it. |

### delete_task

Deletes a task no other task depends on. To close a task instead, set its status to cancelled.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `taskId` | string | yes | The task's ID, or a prefix of it at least 8 characters long, such as its shortId. |

### list_task_history

Returns every write to the task, oldest first.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `taskId` | string | yes | The task's ID, or a prefix of it at least 8 characters long, such as its shortId. |
| `maxResults` | integer |  | The most results to return. Default 100. |
| `nextToken` | string |  | The nextToken from the previous page. |

### list_comments

Returns a task's comments, oldest first.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `taskId` | string | yes | The task's ID, or a prefix of it at least 8 characters long, such as its shortId. |
| `maxResults` | integer |  | The most results to return. Default 100. |
| `nextToken` | string |  | The nextToken from the previous page. |

### create_comment

Adds a comment to a task. A comment changes none of the task's fields.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `taskId` | string | yes | The task's ID, or a prefix of it at least 8 characters long, such as its shortId. |
| `body` | string | yes | The comment, in Markdown. |
| `clientToken` | string |  | A unique string; retrying with it returns what the first request created. |

### list_labels

Returns labels by name.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `maxResults` | integer |  | The most results to return. Default 100. |
| `nextToken` | string |  | The nextToken from the previous page. |

### create_label

Creates a label.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `name` | string | yes | The label's name, unique ignoring case. |
| `color` | string |  | Its colour, as `#rrggbb`. Default `#808080`. |
| `description` | string |  | What the label is for. |
| `clientToken` | string |  | A unique string; retrying with it returns what the first request created. |

### get_label

Returns a label.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `labelId` | string | yes | The label's ID or name. |

### update_label

Changes the fields given.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `labelId` | string | yes | The label's ID or name. |
| `name` | string |  | The label's name, unique ignoring case. |
| `color` | string |  | Its colour, as `#rrggbb`. Default `#808080`. |
| `description` | string |  | What the label is for. |

### delete_label

Deletes a label and removes it from every task that has it.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `labelId` | string | yes | The label's ID or name. |
