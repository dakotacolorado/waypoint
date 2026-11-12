---
name: test
description: How to run waypoint's checks, and which of its release's jobs check, deploy, smoke-check and roll it back. Use before submitting a change to waypoint, and when reviewing one.
---

# Testing waypoint

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
