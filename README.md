# Virtual Event Management API

A REST API for hosting and attending virtual events. Organizers create events with a
fixed number of places; attendees register for them. Built with Node.js, Express 5 and
MongoDB.

The interesting parts are not the CRUD. They are a handful of problems that look
simple and are easy to get subtly wrong:

- **Registration cannot overbook an event**, even under concurrent requests, and a
  repeated request is harmless.
- **Authentication can be revoked.** A JWT alone cannot be taken back; this one can.
- **Config fails loudly at startup** instead of running half-broken.

Each is explained below, with the reasoning for the choice made.

## Quick start

Requires Node 20+ and a MongoDB you can reach.

```bash
cp .env.example .env     # then set JWT_SECRET (the file says how to generate one)
npm ci
npm run dev              # nodemon; use `npm start` for a plain run
```

With Docker, the API and a MongoDB come up together:

```bash
cp .env.example .env     # set JWT_SECRET
docker compose up --build
```

> CI builds the image and runs it against MongoDB on every push, and `docker compose up`
> has been run end to end. See [Status](#status).

The server exposes `GET /health` (is the process up) and `GET /ready` (is the database
reachable) — see [Design decisions](#design-decisions).

## API

Every response is JSON with a `success` boolean. Errors carry `message` and no stack
traces or driver text.

### Auth

| Method | Route         | Auth | Description                                                     |
| ------ | ------------- | ---- | --------------------------------------------------------------- |
| POST   | `/register`   | No   | Create an account (`role`: `attendee` default, or `organizer`)  |
| POST   | `/login`      | No   | Returns a JWT                                                   |
| GET    | `/profile`    | Yes  | The current user, read from the database                        |
| POST   | `/logout-all` | Yes  | Revokes every token the user holds, including the one just used |

### Events

| Method | Route                      | Auth | Role      | Description                                             |
| ------ | -------------------------- | ---- | --------- | ------------------------------------------------------- |
| GET    | `/events`                  | No   | Any       | List events (filters below)                             |
| GET    | `/events/:id`              | No   | Any       | One event                                               |
| POST   | `/events`                  | Yes  | Organizer | Create (`title`, `description`, `startsAt`, `capacity`) |
| PUT    | `/events/:id`              | Yes  | Organizer | Update title, description or start; own events only     |
| DELETE | `/events/:id`              | Yes  | Organizer | Delete; own events only                                 |
| POST   | `/events/:id/register`     | Yes  | Attendee  | Register for an event                                   |
| DELETE | `/events/:id/register`     | Yes  | Attendee  | Cancel registration                                     |
| GET    | `/events/:id/participants` | Yes  | Organizer | Attendees of your own event                             |

`GET /events` query parameters: `upcoming=true`, `organizerId=<id>`, `search=<text>`
(matches title or description).

Rules worth knowing:

- `startsAt` is an ISO 8601 date-time **with a UTC offset** (`2026-12-01T10:00:00Z`)
  and must be in the future. There is no separate date and time field; two fields can
  disagree, and one `Date` can be sorted and range-queried.
- `capacity` is a whole number from 1 to 10,000. It cannot currently be changed after
  creation (a known, documented gap).
- Registering when the event is full is `409`. Registering again when you are already
  registered is `200` with your original registration, so a client retrying after a
  lost response gets the same answer. Organizers cannot register, and past events
  cannot be registered for.
- Identifiers in the API are UUID strings. MongoDB's `_id` never leaves the data layer.

## Design decisions

### No overbooking: one atomic conditional update

The obvious implementation reads the event, checks "is it full? is this user already in
it?", then writes. Under concurrent requests every one of them can pass the check before
any write lands. Instead, registration is a single `findOneAndUpdate` whose filter
requires both that the participant count is below capacity **and** that the user is not
already present, and whose update pushes the participant. It either wins or matches
nothing. Two rules, one operation, no transaction, no version column, no window.

This works because participants are **embedded in the event document**, so capacity and
the participant list are in the same document and one atomic operation can see both.
The trade-off: an embedded array is unbounded and a document is capped at 16 MB. The
`capacity` limit (10,000 places, around 1.5 MB) caps it by construction. If events ever
needed unbounded attendance, registrations would move to their own collection and the
guarantee would need a multi-document transaction.

A test fires concurrent registrations at an event with capacity N and asserts that
exactly N succeed.

### Revocable authentication

A JWT is signed, not encrypted, and proves a claim was true when it was signed — not
that it still is. So the token carries only `sub` (user id) and `ver` (the user's
`tokenVersion`). On **every** request the middleware loads the user from the database,
takes role, name and email from there, and rejects the token if `ver` no longer matches.

That makes a deleted user lose access immediately, a demoted organizer lose organizer
powers immediately, and `POST /logout-all` work by incrementing the version. The cost is
one database read per authenticated request, which is the price of being able to revoke
at all. Every rejected token gets the same `401`; a failed database lookup is a `500`,
never a `401`.

Revocation is per user, not per device: stateless tokens can only be revoked as a group.
Per-device logout would need a stored session id per token, which is the server-side
state JWTs were chosen to avoid.

### Layers

`routes/` handles HTTP and validation. `repositories/` is the only code that touches the
MongoDB driver; it takes and returns plain objects, and no route constructs a filter or
sees an `ObjectId`. That boundary is what makes the storage engine replaceable.
`db/` owns the single shared client. Indexes (unique `users.email`, `users.uuid`,
`events.uuid`, and `events.participants.userUuid`) are created in startup code, with the
reason for each documented next to it.

### Configuration

`config/env.js` is the only file that reads `process.env`. It validates everything at
startup, **collects all problems**, prints them together, and exits non-zero. A key that
is read but never set, and a key that is set but never read, are the same bug from two
sides and neither is a syntax error — one of them once left email silently
non-functional. Crashing beats starting happy-but-broken: a crash-looping container
never receives traffic; a healthy-looking broken one serves real users.

### Health and readiness are different questions

`GET /health` does no dependency checks — it answers "is this process serving HTTP",
a liveness question. A liveness probe that fails when the database is down makes the
orchestrator restart healthy instances and turns a database blip into a rolling outage.
`GET /ready` pings the database and answers `503` when it fails, which means "do not
send me traffic", not "restart me".

### Smaller decisions

- `app.js` builds and exports the app but never listens; only `server.js` opens a port.
  Importing the app therefore has no side effects, and tests run in parallel without
  `EADDRINUSE`.
- Request logging is registered before the body parsers, so a request with malformed
  JSON is logged before it is rejected.
- Logs contain method and path only — never bodies, `Authorization` headers, users, or
  email addresses, because stdout ends up in a long-retention aggregator.
- Every fire-and-forget promise (confirmation emails) has a `.catch()`, because the
  server exits on `unhandledRejection`.
- Email is a courtesy and is deliberately not a boot dependency: if it is not
  configured, the app says so once at startup and carries on.

## Development

```bash
npm run lint          # eslint
npm run format:check  # prettier, verify only (CI uses this); `npm run format` writes
npm test              # jest, against a real MongoDB
```

Tests run against a real database, not a mocked driver — a mocked driver tests the
mock. They use a dedicated database whose name must end in `_test` (default
`mongodb://127.0.0.1:27017/virtual_events_test`, override with `MONGODB_TEST_URI`), and
the suite never reads `MONGODB_URI`, so it cannot reach your development data. Each
Jest worker gets its own database (a numeric suffix), so test files run in parallel
without dropping each other's data. MongoDB
must be running before `npm test`.

## Status

- Auth, persistence, capacity and idempotent registration are implemented and covered
  by the test suite.
- **CI passes on GitHub Actions**: lint, format and the full suite against a real
  MongoDB, plus a `container` job that builds the production image, waits for
  `/ready`, and confirms graceful shutdown (SIGTERM closes the MongoDB connection and
  exits 0). MongoDB is pinned to 7.0 because 8.x refuses to start on the runner's
  kernel (SERVER-121912).
- **`docker compose up --build` verified locally**: MongoDB passes its health check
  before the API starts; sign-up, login, event creation and registration work; two
  concurrent registrations for a one-place event give one `200` and one `409`; a
  repeated registration returns the original; `docker compose stop` exits 0 after
  draining HTTP and closing the MongoDB connection.
- **Known gaps:** capacity cannot be edited after creation; email is fire-and-forget,
  so a crash between committing a registration and sending the email loses the email
  with no record it was owed (fine for a courtesy message, not for a password reset —
  that would need a transactional outbox).

## License

MIT
