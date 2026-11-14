# waypoint

Know where you're going, and each step that gets you there.

A task tracker with dependency and status management. A task depends on other
tasks, and waypoint keeps it from being started while it is blocked by one still
open, or finished before its acceptance criteria are met. It serves a web
page, an HTTP API and an MCP server.

## Run it

```sh
npx github:dakotacolorado/waypoint
```

It needs Node 24 or later.

```
██╗    ██╗ █████╗ ██╗   ██╗██████╗  ██████╗ ██╗███╗   ██╗████████╗  █▀█
██║    ██║██╔══██╗╚██╗ ██╔╝██╔══██╗██╔═══██╗██║████╗  ██║╚══██╔══╝  ▀▀▀▀▄▄       ▄█▄
██║ █╗ ██║███████║ ╚████╔╝ ██████╔╝██║   ██║██║██╔██╗ ██║   ██║           ▀█▀█▄▄█████▄
██║███╗██║██╔══██║  ╚██╔╝  ██╔═══╝ ██║   ██║██║██║╚██╗██║   ██║         ▄▄▀▀▀▀  ▀███▀
╚███╔███╔╝██║  ██║   ██║   ██║     ╚██████╔╝██║██║ ╚████║   ██║     █▀█▀          ▀
 ╚══╝╚══╝ ╚═╝  ╚═╝   ╚═╝   ╚═╝      ╚═════╝ ╚═╝╚═╝  ╚═══╝   ╚═╝     ▀▀▀
v0.6.0

Know where you're going, and each step that gets you there.
A task tracker with dependency and status management.

  ▸ Page      http://127.0.0.1:4400/
  ▸ API       http://127.0.0.1:4400/tasks   docs http://127.0.0.1:4400/docs/api
  ▸ MCP       http://127.0.0.1:4400/mcp     docs http://127.0.0.1:4400/docs/mcp

admin token (shown once, kept only as a hash): wp_…

  listening on http://127.0.0.1:4400, data in ~/.waypoint/waypoint.db
  Ctrl+C to stop.
```

1. Keep the admin token it prints: it is shown once.
2. Open http://127.0.0.1:4400/ and paste the token to sign in.
3. Create a task with **New task**, or through the API or MCP.

![The board](./docs/images/board.png)

`waypoint backup <file>` writes a consistent copy of the database while it
serves.

## Configure it

| Option | Environment | Default | What it does |
|---|---|---|---|
| `--host` | `WAYPOINT_HOST` | `127.0.0.1` | Address to listen on. |
| `--port` | `WAYPOINT_PORT` | `4400` | Port to listen on. |
| `--db` | `WAYPOINT_DB` | `~/.waypoint/waypoint.db` | The SQLite file. |
| `--public-url` | `WAYPOINT_PUBLIC_URL` | its own address | Its address behind a proxy, used in the banner and docs. |
| | `WAYPOINT_ADMIN_TOKEN` | none | An admin token accepted beside the stored ones, never stored. |

Every request takes `Authorization: Bearer <token>` but these, which hold no data: `GetHealth` (`/health`), the contracts (`/openapi.json`, `/mcp.json`), the docs (`/docs/api`, `/docs/mcp`) and the page (`/`, `/ui/…`).
Manage tokens with the CLI; each is shown only when made:

```sh
waypoint token create alice --admin
waypoint token create builds        # a shared token; each caller names itself with x-actor
waypoint token list
waypoint token revoke builds
```

A write is recorded under its `x-actor` header, else its token's name.

## Use it

- API reference: [`docs/API.md`](./docs/API.md), served at `/docs/api`;
  contract in [`openapi.json`](./openapi.json).
- MCP tools: [`docs/MCP.md`](./docs/MCP.md), served at `/docs/mcp`; server at
  `/mcp`.

Create a task, then list the ready ones:

```sh
curl -s -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' http://127.0.0.1:4400/tasks -d '{
  "title": "Write the README",
  "criteria": [{ "text": "Says how to run it" }],
  "subtasks": [{ "title": "Draft it" }, { "title": "Review it", "dependsOn": ["s1"] }]
}'
curl -s -H "authorization: Bearer $TOKEN" 'http://127.0.0.1:4400/tasks?ready=true'
```

Add the MCP server to Claude Code:

```sh
claude mcp add --transport http waypoint http://127.0.0.1:4400/mcp --header "Authorization: Bearer wp_…"
```

`waypoint import work-tracker` copies a work-tracker-service's items into
waypoint; `waypoint --help` gives its options.

## How it works

- `status` is `backlog`, `in_progress`, `review`, `done` or `cancelled`. `done`
  and `cancelled` are closed.
- A task is **ready** when it is in `backlog` and every task it depends on is
  closed. It can move to `in_progress`, `review` or `done` only once they are
  closed, and to `done` only once every criterion is met and every subtask is
  closed.
- **Subtasks** are the steps of a task's work, held to the same rule.
  **Criteria** are what must be true for it to be done.
- **Verification** says who checks that the work does what it should, `agent`
  or `person`, and when, `before_release` or `after_release`. It is null until
  someone sets it.
- Cancelled tasks are left out of lists unless you ask for them.
- **Labels** group tasks. **Comments** sit beside a task, and its **history**
  records every write.

## Develop it

```sh
npm ci               # also builds
npm run dev          # the server on .waypoint-dev.db
npm run typecheck
npm test
npm run build
```

`npm run spec` regenerates `openapi.json`, `mcp.json` and the docs.

## License

MIT. See [LICENSE](./LICENSE).
