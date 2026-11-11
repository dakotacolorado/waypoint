---
name: test
description: How to run waypoint's checks, and which of its release's jobs check, deploy, smoke-check and roll it back. Use before submitting a change to waypoint, and when reviewing one.
---

# Testing waypoint

The release is the routine `dakotacolorado/release-routines` at
`dakotacolorado/waypoint/`: `pipeline.toml` its steps, `jobs.toml` each job's
`run`, changed only through the release service. `build`, `typecheck` and
`test` run in the image its `Containerfile` builds (base-node with curl);
the rest are host jobs on the stage's host. This skill names the jobs; their
commands are only there.

| Step | Jobs |
|---|---|
| `build` | `build` |
| `unit-test` | `typecheck`, `test` |
| `deploy-beta`, `rollback-beta` | `deploy-beta`, on `dakotas-hp-laptop` |
| `integration-test-beta` | `smoke-beta` (read-only), `integration-beta` (writes to beta) |
| `deploy-prod`, `rollback-prod` | `deploy-prod`, on `dakotas-lenovo-laptop` |
| `integration-test-prod` | `smoke-prod` (read-only) |

**Deploys and rollbacks are approval-service's.** No author or agent runs a
`deploy-*` job, a rollback, or the routine's `deploy` script. Each stage runs
as the user service `waypoint.service` on 127.0.0.1:4400, served at
`/waypoint` on its host's Tailscale HTTPS name, its data in
`~/.local/share/waypoint/waypoint.db` and its admin token in
`~/.config/waypoint/env`, never committed; `waypoint-backup.timer` copies a
`waypoint backup` of it to the other host each night, keeping 14 days.

## The checks: `build` and `unit-test`

An author runs these at the PR's head before submitting it, and a reviewer at
the commit reviewed. Each must exit 0. In a clean clone, with Node 24 and npm,
and the session's `*_URL`/`*_TOKEN` pairs unset so nothing reaches a deployed
service:

```sh
env -u DS_URL -u DS_TOKEN -u WT_URL -u WT_TOKEN -u WS_URL -u WS_TOKEN -u AS_URL -u AS_TOKEN -u JS_URL -u JS_TOKEN npm ci
env -u DS_URL -u DS_TOKEN -u WT_URL -u WT_TOKEN -u WS_URL -u WS_TOKEN -u AS_URL -u AS_TOKEN -u JS_URL -u JS_TOKEN npm run typecheck
env -u DS_URL -u DS_TOKEN -u WT_URL -u WT_TOKEN -u WS_URL -u WS_TOKEN -u AS_URL -u AS_TOKEN -u JS_URL -u JS_TOKEN npm test
env -u DS_URL -u DS_TOKEN -u WT_URL -u WT_TOKEN -u WS_URL -u WS_TOKEN -u AS_URL -u AS_TOKEN -u JS_URL -u JS_TOKEN npm run build
```

Run each on its own and read its exit status (`echo $?`). Never pipe one into
`tail` or `head`: the pipe reports their status, so a failure reads as a pass.

`npm test` needs no network and no service: the store runs on SQLite in
memory, and `src/cli.spec.ts` starts the server on ports the OS picks. It
skips `src/integration.spec.ts` (6 tests), which writes to a running server
given `INTEGRATION_WT_URL` and `INTEGRATION_WT_TOKEN`; never point those at
prod.

Installing points git at `.githooks/`, whose pre-commit runs `npm run spec`.
