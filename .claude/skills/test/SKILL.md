---
name: test
description: How to run waypoint's checks, and where its beta and prod run. Use before submitting a change to waypoint, and when reviewing one.
---

# Testing waypoint

It is not released by approval-service. Each host runs it by hand as the
user service `waypoint.service`: beta on `dakotas-hp-laptop`, prod on
`dakotas-lenovo-laptop`, each on 127.0.0.1:4400 and served at the root of
port 8444 on its Tailscale HTTPS name (as honed is at 8443), its data in `~/.local/share/waypoint/waypoint.db`
and its admin token in `~/.config/waypoint/env`, never committed;
`waypoint-backup.timer` copies a `waypoint backup` of it to the other host
each night, keeping 14 days.

## The checks

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
memory, and `src/cli.spec.ts` starts the server on ports the OS picks and runs
the `wt` it serves, which needs `curl`. It
skips `src/integration.spec.ts` (6 tests), which writes to a running server
given `INTEGRATION_WT_URL` and `INTEGRATION_WT_TOKEN`; never point those at
prod.

Installing points git at `.githooks/`, whose pre-commit runs `npm run spec`.
