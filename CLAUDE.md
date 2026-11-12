# Working in this package

Keep it fact-dense: the code carries the facts. **Prefer a mechanism to a
comment** — a type, a test or a thrown error cannot rot.

Comment only for a limit a reader would otherwise violate, a deliberate choice
that reads as a mistake, or platform behaviour not visible in the source. Never
restate the code or narrate how it came to be.

## Contract

`src/schema.ts` is the source of `openapi.json` and `docs/API.md` (written by
`src/api-doc.ts` in an AWS reference's layout); `src/mcp.ts` of `mcp.json` and
`docs/MCP.md`. The pre-commit hook regenerates them (`npm run spec`); a test
fails if they drift. Operations are named `VerbNoun` as AWS names them, each
summary the same words, every field described. Every MCP tool is one API
request, so a rule lives in the API alone. The page, `ui/`, is plain JS over
the API: make every element with `h`, which sets text, never HTML.

Each stored record is its JSON in SQLite.

## Tests

Colocated as `*.spec.ts`; test our rules, not the library's. The checks are
`npm run typecheck`, `npm test` and `npm run build`. Store tests run on a real
SQLite database in memory (`src/fake-store.ts`).
How to run the checks: `.claude/skills/test/SKILL.md`.
