# waypoint

A task tracker for people and the agents working with them: epics, stories and
tasks, with dependencies between them and a status that rolls up from below.
One Node process serves a web page, an HTTP API and an MCP server, and keeps
everything in one SQLite file.

```sh
npx @dakotajp/waypoint
```

```
██╗    ██╗ █████╗ ██╗   ██╗██████╗  ██████╗ ██╗███╗   ██╗████████╗    ▄▄████▄▄
██║    ██║██╔══██╗╚██╗ ██╔╝██╔══██╗██╔═══██╗██║████╗  ██║╚══██╔══╝   ███▀  ▀███
██║ █╗ ██║███████║ ╚████╔╝ ██████╔╝██║   ██║██║██╔██╗ ██║   ██║      ███▄  ▄███
██║███╗██║██╔══██║  ╚██╔╝  ██╔═══╝ ██║   ██║██║██║╚██╗██║   ██║       ████████
╚███╔███╔╝██║  ██║   ██║   ██║     ╚██████╔╝██║██║ ╚████║   ██║        ▀████▀
 ╚══╝╚══╝ ╚═╝  ╚═╝   ╚═╝   ╚═╝      ╚═════╝ ╚═╝╚═╝  ╚═══╝   ╚═╝          ██
📍 v0.1.0

Know where the work is, and what it waits on.
Epics, stories and tasks for people and their agents, with dependencies and a status that rolls up from below.

  ▸ Page      http://127.0.0.1:4400/
  ▸ API       http://127.0.0.1:4400/items   docs http://127.0.0.1:4400/docs/api
  ▸ MCP       http://127.0.0.1:4400/mcp     docs http://127.0.0.1:4400/docs/mcp

admin token (shown once, kept only as a hash): wp_…

  no worker-service configured: queued items wait
  listening on http://127.0.0.1:4400, data in ~/.waypoint/waypoint.db
  Ctrl+C to stop.
```

Node 24 or later. Nothing else: no cloud account, no other service.

| Path | What |
|---|---|
| `/` | the page: a board by status, each item's page, a form for new ones |
| `/items`, `/tags`, … | the API ([`openapi.json`](./openapi.json), docs at `/docs/api`) |
| `/mcp` | the MCP server ([`mcp.json`](./mcp.json), docs at `/docs/mcp`) |
| `/health` | liveness, with the version and commit |

![The board](./docs/images/board.png)

## The page

Open the address it printed and paste the admin token. The board shows open
items in their status columns, filtered by type or epic; an item's page shows
its parents, body, acceptance criteria (tick them there), children,
dependencies, tags, comments, work log and history, and moves, closes, edits
and adds beneath it. It is plain HTML and JavaScript over the same API, with
no build step.

## Try the API

```sh
export WT_URL=http://127.0.0.1:4400 WT_TOKEN=wp_…   # the admin token it printed
curl -s -H "authorization: Bearer $WT_TOKEN" -H 'content-type: application/json' \
  -d '{"type":"epic","title":"Ship the first release"}' $WT_URL/items
```

or with its client, [`skill/bin/wt`](./skill/bin/wt), which needs only `curl`
and those two variables:

```sh
skill/bin/wt POST /items '{"type":"story","title":"Write the README","parent":"<epic id>"}'
skill/bin/wt GET '/items?state=open'
skill/bin/wt PATCH /items/<id> '{"status":"in_progress"}'
```

## What it keeps

- **Items** at three levels: an epic has no parent, every story has an epic,
  every task has a story. An item's `status` is a board column (`backlog`,
  `ready`, `in_progress`, `review`, `done`); a parent's is derived from its
  open children's. `state` is separate: `open`, or `closed` as `completed` or
  `not_planned`.
- **Dependencies** between siblings only. `blockedBy` lists what an item, or
  one above it, still waits on, and a move to `in_progress`, `review` or `done`
  is refused with 409 until it is empty.
- **History** of every write, under the item and every item above it.
- **Comments**, **a work log** with links, and **acceptance criteria** ticked
  one at a time.
- **Tags**, a shared list of labels, each carried down to everything beneath
  the item it is put on.
- **A queue**: stories and tasks to start on their own, in order, up to a
  running limit, when a worker-service is configured (below).

[`skill/reference/statuses.md`](./skill/reference/statuses.md) has the rules
in full, and the API is [`openapi.json`](./openapi.json), rendered in
[`docs/API.md`](./docs/API.md) and served at `/openapi.json`.

## Tokens

Every request but `/health` and `/openapi.json` takes a bearer token. Tokens
are kept as hashes in the database, so each is shown only when made:

```sh
waypoint token create alice --admin   # a person's
waypoint token create agents          # shared by agents, who say who they are by `claimed-by`
waypoint token list
waypoint token revoke agents
```

A write is recorded as its `claimed-by` header's, else as its token's name.
Only an admin token's write that names nobody is the person's, which alone may
sign off an epic with children, force a move past its dependencies, or set
the queue's running limit. `WAYPOINT_ADMIN_TOKEN`, if set, is an admin token
too, never stored: for a host that keeps its secrets in its own environment.
With no admin token at all, `waypoint serve` makes one and prints it.

## Options

| Flag | Environment | Default |
|---|---|---|
| `--host` | `WAYPOINT_HOST` | `127.0.0.1` |
| `--port` | `WAYPOINT_PORT` | `4400` |
| `--db` | `WAYPOINT_DB` | `~/.waypoint/waypoint.db` |
| `--ui-url` | `WAYPOINT_UI_URL` | this server's address: where links to items open |

Back it up while it runs: `waypoint backup copy.db` takes SQLite's online
backup of the database (`--db`), consistent while writes go on.

## Agents

### MCP

Point an MCP client at `/mcp` with a token:

```json
{ "mcpServers": { "waypoint": { "type": "http", "url": "http://127.0.0.1:4400/mcp", "headers": { "Authorization": "Bearer wp_…" } } } }
```

Each of its 19 tools (`list_items`, `create_item`, `update_item`,
`add_work_log`, `tick_criterion`, …) is one API request made with the
client's token and `claimed-by`, so it is refused and recorded as that request
would be. [`docs/MCP.md`](./docs/MCP.md) lists them with their inputs.

### The wt client

`GET /skill` serves the client as a [Claude Code](https://claude.com/claude-code)
skill's files, `skills/work-tracker/bin/wt` and its `reference/`, for a
harness to lay into an agent's skills folder.

### Starting agents (optional)

With `WAYPOINT_WORKERS_URL` and `WAYPOINT_WORKERS_TOKEN` set, waypoint starts
agents through a worker-service: `POST /items/{id}/assignment` asks for one on
an item, and every 5 minutes the dispatcher starts queued items up to the
running limit (`PATCH /queue`). Without them it never calls out: queued items
wait, and starting one answers 503.

## Developing

```sh
npm ci
npm run dev          # the server on .waypoint-dev.db
npm run typecheck
npm test
npm run build
```

`src/schema.ts` is the source of `openapi.json`, `docs/API.md`,
`docs/index.html` and `skill/reference/api.md`; `src/mcp.ts` of `mcp.json`,
`docs/MCP.md` and `docs/mcp.html`. `npm run spec` regenerates them all, as the
pre-commit hook does, and a test fails if any drifts. The page is `ui/`.

## License

MIT
