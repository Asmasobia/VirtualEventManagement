// ─────────────────────────────────────────────────────────────────────────────
//  THE ONE MongoDB CLIENT FOR THE PROCESS: connect once, reuse, close on shutdown.
//
//  Why a single module owns this, rather than each caller doing
//  `new MongoClient(...)`: a MongoClient is not a connection, it is a POOL of
//  them plus background monitoring of the server. Constructing one per request
//  would open and tear down a pool per request — slow, and under load it
//  exhausts the server's connection limit. One client, created at startup,
//  shared by everything, is the pattern the driver is designed around.
//
//  This file does not connect when it is required. Like `app.js`, it defines
//  things and does not start them: `server.js` calls `connect()` explicitly, in
//  a place where a failure can be caught and turned into a clean exit. A module
//  that dialled the database as an import side effect would make every test that
//  touches the app depend on a live server.
//
//  Nothing outside `db/` and the repository layer should import the driver or
//  call `getDb()` — routes talk to repositories, which take and return plain
//  domain objects.
// ─────────────────────────────────────────────────────────────────────────────

const os = require("os");
const { MongoClient } = require("mongodb");
const config = require("../config/env");

// Without this the driver waits 30 seconds to give up on an unreachable server.
// At startup that is 30 seconds of a process that looks hung; 5 is plenty for a
// database that is actually there, and failing fast is what lets the orchestrator
// restart us sooner.
const SERVER_SELECTION_TIMEOUT_MS = 5_000;

let client = null;
let db = null;
let connecting = null;

// ─── Indexes ─────────────────────────────────────────────────────────────────
//
//  Created at startup, not through a migration directory: for this slice that is
//  deliberate (see CLAUDE.md). It is also the first thing to revisit if the
//  project ever gets a second deployment target, because "every instance races to
//  build indexes on boot" is fine for four indexes and not fine for forty.
//
//  `createIndexes` is idempotent: asking for an index that already exists with an
//  identical definition is a no-op. That is what makes it safe to run on every
//  start. Asking for the same NAME with a DIFFERENT definition is an error, which
//  is the behaviour we want — it means someone edited this list without thinking
//  about the data already in production.
//
//  The unique indexes are the real enforcement of two rules. `users.email`
//  uniqueness used to be an array scan in application code, which is a
//  check-then-write race: two concurrent registrations both pass the scan and
//  both insert. A unique index makes the second insert fail inside the database,
//  atomically, regardless of how many app instances are running.
const INDEXES = {
  users: [
    { key: { email: 1 }, name: "users_email_unique", unique: true },
    { key: { uuid: 1 }, name: "users_uuid_unique", unique: true },
  ],
  events: [
    { key: { uuid: 1 }, name: "events_uuid_unique", unique: true },
    // NOT unique, and on purpose: this is a lookup index, answering "which events
    // is this user registered for" without scanning every event. On an array
    // field MongoDB builds a MULTIKEY index — one entry per array element — so
    // each participant gets their own entry pointing back at the event.
    //
    // Uniqueness of a user WITHIN one event's array is a different rule, and a
    // unique multikey index would not express it (it enforces uniqueness across
    // documents, not within one). That rule is enforced by the conditional
    // update in eventsRepository.addParticipant.
    {
      key: { "participants.userUuid": 1 },
      name: "events_participants_userUuid",
    },
  ],
};

async function ensureIndexes(database) {
  for (const [collection, specs] of Object.entries(INDEXES)) {
    // Creating an index on a collection that does not exist yet creates the
    // collection, which is why no separate "create collection" step exists.
    await database.collection(collection).createIndexes(specs);
  }
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

/**
 * Connect once and make sure the indexes exist. Idempotent: a second call returns
 * the existing database rather than opening a second pool.
 *
 * Rejects if the server is unreachable or the indexes cannot be built; the caller
 * (server.js) treats that as fatal. Starting without the unique indexes would be
 * worse than not starting, because the app would run and quietly accept duplicates.
 */
function connect() {
  // Cache the PROMISE, not the result. Checking `if (db)` after an await would
  // let two overlapping calls both see "not connected yet" and each open a pool —
  // the exact thing "one client" is meant to rule out. Sharing the in-flight
  // promise makes the second caller wait for the first.
  if (!connecting) {
    connecting = open().catch((err) => {
      // Clear on failure so a later call can retry instead of replaying the
      // same rejection forever.
      connecting = null;
      throw err;
    });
  }
  return connecting;
}

async function open() {
  const candidate = new MongoClient(config.mongodb.uri, {
    serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS,
    // Driver 7 loads the `os` module with a dynamic import(). Jest's CommonJS
    // sandbox rejects that without --experimental-vm-modules, which left the
    // handshake's client metadata empty, and the server then refused the
    // connection with "Missing required sub-document 'driver'". Handing the
    // module over explicitly skips the dynamic import; it is a documented
    // driver option and behaves identically outside Jest.
    runtimeAdapters: { os },
  });

  try {
    // The database name comes from config, not from `db()` with no argument
    // (which would use the URI's path). In tests the two differ: config adds a
    // per-Jest-worker suffix so parallel test files never share a database.
    await candidate.connect();
    const database = candidate.db(config.mongodb.dbName);
    await ensureIndexes(database);
    client = candidate;
    db = database;
    return database;
  } catch (err) {
    // A half-started client would keep its monitoring sockets open and, in a
    // test that expects the failure, keep Jest from exiting. Best-effort close;
    // the original error is the one worth surfacing.
    await candidate.close().catch(() => {});
    throw err;
  }
}

/** The connected database. Throws, rather than returning null, if `connect()` has not completed. */
function getDb() {
  if (!db) {
    throw new Error("Database is not connected. Call connect() first.");
  }
  return db;
}

// A readiness probe that hangs is worse than one that fails: orchestrators give
// probes a short deadline (often 1s) and treat a timeout as a failure anyway, but
// a ping that waits on the driver's defaults ties up a request for far longer.
// Bound it here so "database stuck" and "database down" both answer quickly.
const PING_TIMEOUT_MS = 2_000;

/**
 * Round-trip to the server. Resolves if the database answers, rejects if it is
 * not connected, unreachable, or slower than PING_TIMEOUT_MS. Readiness only —
 * never call this from the liveness path.
 */
async function ping() {
  await getDb().command({ ping: 1 }, { timeoutMS: PING_TIMEOUT_MS });
}

/** Close the pool. Safe to call when never connected or already closed. */
async function close() {
  const closing = client;
  client = null;
  db = null;
  connecting = null;
  if (closing) await closing.close();
}

// Exported for the test harness, which drops the database (and with it every
// index) before each test and must put the indexes back. Tests that ran without
// the unique indexes would pass on duplicates that production rejects.
module.exports = { connect, getDb, ping, close, ensureIndexes, INDEXES };
