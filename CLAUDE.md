# Working notes for this repository

Instructions for any AI assistant working in this repo, and a summary of decisions
already made so they are not re-litigated or accidentally undone.

---

## What this project is

A REST API for hosting and attending virtual events: JWT auth, role-based access
(`organizer` / `attendee`), event lifecycle, attendee registration.

It began as a course assignment and is being deliberately deepened into a portfolio
piece. That goal shapes every decision below: the code is meant to be **read and
defended by its author in an interview**. Cleverness that cannot be explained out
loud is worse than nothing.

---

## How to work here

**Work in small, reviewable chunks.** Make a change, say what changed and why, run
the checks, show the output. Do not make an hour of edits and then narrate them
retrospectively — that produces a wall of code nobody can review and blocks the
author while they wait.

**Give a time estimate before anything large**, and stop for review at PR
boundaries. Review time is the bottleneck, not output speed. One PR read properly
beats six landed unread.

**Comments explain reasoning, not syntax.** The standard in this codebase is that
reading the comments alone conveys _why_ the code is shaped this way — what the
alternative was, what broke, what the trade-off is. Aimed at a competent engineer
who has not seen this code. Look at `config/env.js`, `app.js` or
`services/emailService.js` for the established tone before writing new files.

**Verify claims, don't assert them.** If something is stated as working, there
should be command output backing it. If something cannot be verified on the current
machine, say so explicitly and label it unverified — never round it up to "done".

---

## Checks — all three must pass

```bash
npm run lint          # eslint . — prints nothing on success
npm run format:check  # prettier --check .
npm test              # jest — 39 tests currently passing
```

`npm run format` writes; `format:check` only verifies. CI uses `check`, because a CI
job that silently rewrites files is worse than one that fails.

⚠️ **Prettier is not always idempotent here.** A freshly written file can need two
`--write` passes to reach a fixed point (its member-chain printer collapses
`res.status(400).json({...})` differently on the second pass). If `format:check`
fails immediately after formatting, run `npm run format` once more and re-check.

---

## Architectural invariants — do not undo these

Each of these fixed a real bug. Reverting one reintroduces it.

1. **`app.js` builds the app and exports it. It does not listen.** `server.js` is
   the only file that opens a socket. Putting `app.listen()` back in `app.js` means
   importing the app opens a TCP port as a side effect, which forces
   `jest --runInBand` and breaks any parallel test run with `EADDRINUSE`. Supertest
   binds its own ephemeral port and never needed a listener.

2. **`config/env.js` is the only file that reads `process.env`.** It validates at
   startup, collects _all_ problems before exiting, and exits non-zero. Rationale: a
   config key read but never set, and a key set but never read, are the same bug from
   two sides and neither is a syntax error. (That exact bug made email silently
   non-functional — the code read `EMAIL_SERVICE`, the environment defined
   `EMAIL_HOST`.) Crashing beats starting happy-but-broken: a crash-looping container
   never receives traffic, a broken-but-healthy one serves real users.

3. **The error handler declares four parameters.** Express identifies an error
   handler by _arity_. Dropping the unused `next` silently demotes it to ordinary
   middleware that never runs on error. It carries an explicit
   `eslint-disable-next-line no-unused-vars` — the linter is deliberately _not_
   configured to exempt `next` globally, because an unused `next` elsewhere means
   middleware that neither continues nor responds, leaving requests hanging.

4. **Request logging is registered BEFORE the body parsers.** `express.json()`
   throws on a malformed body and jumps straight to the error handler, skipping
   every middleware in between — so a garbage request was answered with a 400 that
   appeared in no log. Observability goes as early as possible; it wraps request
   handling rather than being a step in it.

5. **`/health` does no dependency checks.** It answers "is this process serving
   HTTP" — a Kubernetes _liveness_ question. A liveness probe that fails when the
   database is down makes the orchestrator restart healthy pods, turning a DB blip
   into a rolling outage. Dependency checks belong on a separate _readiness_
   endpoint, which arrives with the database in PR 1.

6. **Logs contain metadata, never payloads.** No request bodies, no `req.user`, no
   `Authorization` headers, no recipient email addresses. stdout is shipped to a
   long-retention searchable aggregator, so a debug line becomes unmanaged personal
   data outside the app's own deletion guarantees.

7. **Every fire-and-forget promise has a `.catch()`.** `server.js` exits the process
   on `unhandledRejection`, so an un-awaited rejection without a handler takes the
   server down. A failed courtesy email must not do that.

---

## Roadmap

PR 0 is done. The remaining slices, in order, with the estimates the author agreed
to:

| PR  | Content                                                                                                                                                    | Est.   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 0   | ✅ Hygiene: split app/server, config validation, strip debug logs, fix email config, ESLint + Prettier                                                     | done   |
| 1   | **MongoDB** + repository layer, collapse `date`+`time` into one `Date`, tests against a real DB, readiness probe — see **PR 1: the engine decision** below | ~4 h   |
| 2   | Fix auth properly: real user lookup + `token_version` revocation, and fix the _test seeding_ that caused the shortcut                                      | ~1.5 h |
| 3   | `capacity` + idempotent registration + a test proving no overbooking under concurrent requests                                                             | ~2.5 h |
| 4   | Dockerfile + compose + GitHub Actions CI                                                                                                                   | ~1.5 h |
| 5   | README rewrite                                                                                                                                             | ~1 h   |

TypeScript conversion, if wanted, is a final mechanical PR _after_ the domain model
is real — not before.

### PR 1: the engine decision

**Changed 26 Sep 2026, by the author, after the original plan named Postgres.** The
slice is unchanged — _introduce persistence_ — but the engine is now **MongoDB**.

The reason is portfolio coverage, not engineering merit. Postgres is already the
store in three other projects of the author's, so a fourth adds nothing they can
claim; MongoDB is the one gap with nothing built behind it. Both engines solve this
domain comfortably, so the tie is broken on what the work is worth afterwards.

**Do not treat this as an invitation to reopen it.** If Mongo turns out to make a
later slice materially worse, say so with the specific slice named and let the author
decide — do not switch back unilaterally.

What this changes against the original PR 1:

- **No `node-pg-migrate`, and no migration tooling at all in PR 1.** Collections are
  created on first write. Index creation is explicit and lives in startup code, not in
  a migration directory — see the index note below.
- **`date` + `time` collapse into a single `Date` field**, not a `timestamptz`. Same
  bug being fixed (two fields that can disagree, and no way to sort or range-query
  correctly), same shape of fix. Store UTC; never store a local-time string.
- **`_id` is Mongo's `ObjectId`.** The API must keep returning the existing `uuid`
  string identifiers — a change of public identifier format is a breaking API change
  and is not part of this slice. Keep the `uuid` field, put a unique index on it, and
  look up by it. `_id` stays internal.

What does **not** change, and must not be quietly dropped:

- **The repository layer is the point of the slice, not the driver.** `routes/` must
  not import the Mongo driver, construct a filter, or see an `ObjectId`. Route
  handlers call repository functions that take and return plain domain objects. This
  is what makes the engine swappable and it is the reason the slice is worth 4 hours
  rather than 1.
- **Tests run against a real database**, not a mocked driver. A mocked driver tests
  the mock. Use a dedicated test database name, and drop it between runs rather than
  truncating by hand.
- **The readiness probe arrives here** — invariant 5. `/health` stays dependency-free;
  readiness pings the database. A failing ping means _not ready_, never _not alive_.
- **`config/env.js` remains the only reader of `process.env`** — invariant 2. The
  connection string arrives as one validated variable, `MONGODB_URI`, and an absent or
  unparseable value must fail at startup with every other config problem collected
  alongside it, not on the first query.
- **Connection lifecycle is explicit.** Connect once at startup before the socket
  opens; close it in the existing `server.js` shutdown path alongside the HTTP drain.
  One client, reused — not a connection per request.
- **Invariant 7 still applies.** Any un-awaited database call needs a `.catch()`.

Indexes to create at startup, and the reason each exists. Creating them in startup code
rather than a migration directory is deliberate for this slice; it is also the thing to
revisit first if the project ever gets a second deployment target:

| Index                          | Why                                                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `users.email` unique           | Registration currently scans an array; the uniqueness rule belongs in the database                        |
| `users.uuid` unique            | Public identifier lookups                                                                                 |
| `events.uuid` unique           | Public identifier lookups                                                                                 |
| `events.participants.userUuid` | Answering "what is this user registered for" without scanning every event — see the dual-write note below |

**Keep registrations embedded in the event document; do not normalise them into their
own collection.** Today they already live in `event.participants`, and keeping them
there is what makes PR 3 clean: capacity and the participant list are in the _same
document_, so one atomic operation can enforce both rules at once. Split across two
collections, the same guarantee needs a multi-document transaction.

The trade-off, stated because it is the thing an interviewer would probe: an embedded
array is unbounded, and a document has a hard size ceiling. For per-event attendee
counts that is not a real constraint, and a capacity field caps it by construction. If
capacity ever became unbounded, a separate collection plus a transaction is the right
answer — but that is not this domain.

**A note for PR 3, written down now so PR 1 does not paint it into a corner.** The
original plan said "optimistic concurrency," which was Postgres phrasing. On Mongo the
no-overbooking _and_ no-duplicate guarantee is **one atomic conditional update**: a
single `findOneAndUpdate` whose filter requires both that the participant count is
below capacity and that this user is not already in the array, and whose update pushes
the participant. It either wins or matches no document — no transaction, no version
column, no read-then-write window. Two rules, one operation.

The overbooking test stays exactly as specified: fire concurrent registrations at an
event with capacity N and assert exactly N succeed. **Do not implement this as
read-then-check-then-write. That is the bug the test exists to catch, and it is the bug
the current code has** — `routes/events.js` reads `event.participants`, checks
`alreadyRegistered`, then pushes, which is a race under any real concurrency.

**✅ Resolved ahead of PR 1 — the registration dual write.** Registration used to push
the participant onto `event.participants` _and_ the event id onto
`user.registeredEvents`: two sources of truth for one fact, with nothing keeping them
consistent, so a failure between the two writes left them disagreeing permanently. The
mirror was never read by anything, so it was deleted outright; `event.participants` is
now the only record, and the user's list is derived by query against the index above.
**Do not reintroduce the mirror in the new data layer.**

Environment and setup:

- **Resolved: the author chose a local MongoDB Community Server install** (portable,
  no admin rights, localhost only, not a service — it must be started by hand before
  running tests). There is still no working Docker daemon on this machine. Install
  paths and start/stop commands are machine-specific and live in the gitignored
  `MONGODB.local.md`, not here.
- If a hosted cluster is ever used instead, the connection string is a **credential**. It belongs in
  `.env` only. `.env.example` gets a placeholder with no host, no user and no
  password. Never paste a real URI into a committed file, a log line, an error
  message, or the README.

---

## Known deliberate debt

Documented rather than hidden. Do not "fix" these out of order; each has a PR.

- **`middleware/auth.js` trusts the JWT payload and does not look the user up.**
  This is the most serious issue in the codebase and it is flagged in-file. A deleted
  user keeps access, a demoted organizer keeps organizer powers, and there is no
  revocation. It was changed to make a test-fixture problem go away, which is the
  wrong direction of causation — production auth was weakened to suit a test. **PR 2**
  fixes both halves: the real lookup _and_ the test seeding.
  Remember a JWT is signed, not encrypted, and proves a claim was signed in the past,
  not that it is still true. Anything mutable (role, account status) must come from
  the system of record.

- **`data/store.js` is an in-memory object.** Seven lines: `{ users: [], events: [] }`.
  All state dies with the process, and there is no persistence of any kind — not a
  file, not a JSON document on disk. PR 1 therefore _introduces_ a data layer rather
  than swapping one out, which is why it carries the repository boundary, the indexes
  and the readiness probe with it.

- **Email is fire-and-forget.** If the process dies between committing a
  registration and the SMTP call completing, the email is lost with no record that it
  was owed. Acceptable for a courtesy notification, _not_ for anything a user depends
  on (password reset, receipt) — those need a transactional outbox: write the intent
  in the same transaction as the state change, deliver from a worker.

- **Graceful shutdown in `server.js` is UNVERIFIED.** The SIGTERM/SIGINT handlers are
  written but were never observed running: `kill -TERM` from Git Bash does not
  deliver a catchable signal to Node on Windows, so the process exited cleanly while
  the handler's log lines never appeared. **Verify this in PR 4 under Docker on
  Linux** and do not describe it as working until then.

- **14 repetitions of `return res.status(N).json({ success: false, message })`.**
  A `fail(res, status, message)` helper was proposed and deferred to keep PR 0's
  review small. Offered, not yet accepted.

---

## Repository hygiene — non-negotiable

This repo is public. Everything committed is permanent and world-readable.

- **No secrets, ever.** `.env` is gitignored; `.env.example` holds placeholders only.
  Note `.gitignore` is _last-match-wins_ and `.env.*` does **not** match a bare
  `.env` — both patterns are needed, and the `!.env.example` negation must come
  after them. Verify with `git add --dry-run .` or `git status --ignored=matching`,
  **not** `git check-ignore`, whose exit codes are misleading around negations.

- **No employer, client, or internal-system identifiers** of any kind: no company or
  product names, no internal service names, hostnames, ports, API paths, or custom
  headers from any workplace system. Nothing in this repo may reveal where its author
  works or what they work on.

- **No machine-specific data**: no OS build numbers, hardware specs, absolute paths
  containing a username (use `~` or `%USERPROFILE%`), or local database ports.
  Machine-specific values live in `.env`, which is gitignored.

- **Never bypass corporate network controls** to get a dependency: no
  `verify=False`, no disabling TLS verification, no turning off a VPN to reach a
  blocked host. Use a cache, an internal proxy, or ask IT to allowlist.

- **Confirm before anything outward-facing** — pushing, opening a PR, creating a
  release. Local commits are fine; publishing is the author's call each time.

See also `HANDOFF.local.md` if present — it is gitignored and holds the
machine-specific details that must not be committed.
