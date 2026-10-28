// ─────────────────────────────────────────────────────────────────────────────
//  TEST HARNESS FOR THE REAL DATABASE.
//
//  Tests run against a live MongoDB, not a mocked driver: a mocked driver tests
//  the mock, and the bugs this project cares about (a unique index rejecting a
//  duplicate, an atomic update losing a race) only exist in the real server.
//  Start mongod by hand first — see MONGODB.local.md.
//
//  Which database: config/env.js resolves it from MONGODB_TEST_URI, insists the
//  name ends in `_test`, and suffixes the Jest worker id, so parallel test files
//  never share one. This file never chooses a name itself.
//
//  Why DROP, not delete-the-documents: a drop takes the collections and their
//  indexes with it, so there is no per-collection cleanup list to keep in sync as
//  collections are added — the failure mode of hand-truncation is a new
//  collection someone forgot, leaking state between tests. The indexes are then
//  rebuilt with the same `ensureIndexes` startup uses, so every test sees exactly
//  the constraints production enforces.
//
//  Why BEFORE each test rather than after: a clean start is guaranteed even if
//  the previous run crashed half-way, and the data from a failing test is still
//  there afterwards to inspect in mongosh.
// ─────────────────────────────────────────────────────────────────────────────

const db = require("../../db/client");

/** Register connect / reset / close hooks for the calling test file. */
function useTestDatabase() {
  beforeAll(async () => {
    await db.connect();
  });

  beforeEach(async () => {
    const database = db.getDb();
    await database.dropDatabase();
    await db.ensureIndexes(database);
  });

  // Without this the driver's monitoring sockets keep Jest from exiting.
  afterAll(async () => {
    await db.close();
  });
}

module.exports = { useTestDatabase };
