# Working in this package

Keep it fact-dense: the code carries the facts. **Prefer a mechanism to a
comment** — a type, a test or a thrown error cannot rot.

Comment only for a limit a reader would otherwise violate, a deliberate choice
that reads as a mistake, or platform behaviour not visible in the source. Never
restate the code or narrate how it came to be.

## Contract

`src/schema.ts` is the source of `openapi.json` and `docs/`. The pre-commit hook
regenerates them (`npm run spec`); a test fails if they drift.

Each stored record is its JSON in SQLite. Records may carry fields since
removed: `store.ts` reads each field it knows with a fallback and ignores the
rest. Never require a migration.

## Tests

Colocated as `*.spec.ts`; test our rules, not the library's. The checks are
`npm run typecheck`, `npm test` and `npm run build`. Store tests run on a real
SQLite database in memory (`src/fake-store.ts`). Integration tests hit a
running server and skip without `INTEGRATION_WT_URL`/`INTEGRATION_WT_TOKEN`.
How to run the checks, and which pipeline jobs deploy and roll back: `.claude/skills/test/SKILL.md`.
