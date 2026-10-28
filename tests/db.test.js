const config = require("../config/env");
const db = require("../db/client");
const { useTestDatabase } = require("./helpers/db");

// Tests of the harness itself. Every later repository test trusts these
// properties, so they are checked once here rather than assumed everywhere.

useTestDatabase();

describe("test database harness", () => {
  it("uses a disposable, per-worker database — never the dev one", () => {
    expect(db.getDb().databaseName).toBe(config.mongodb.dbName);
    expect(config.mongodb.dbName).toMatch(/_test_\d+$/);
  });

  // These two run in order: the first writes, the second proves the write is
  // gone. That is the isolation guarantee every other test depends on.
  it("writes a document", async () => {
    await db.getDb().collection("users").insertOne({ uuid: "u-1" });
    expect(await db.getDb().collection("users").countDocuments()).toBe(1);
  });

  it("starts every test with no data left over from the previous one", async () => {
    expect(await db.getDb().collection("users").countDocuments()).toBe(0);
  });

  it("restores the startup indexes after the drop", async () => {
    for (const [collection, specs] of Object.entries(db.INDEXES)) {
      const names = (await db.getDb().collection(collection).indexes()).map(
        (index) => index.name,
      );
      for (const spec of specs) expect(names).toContain(spec.name);
    }
  });

  it("enforces unique indexes, so tests see production's constraints", async () => {
    const users = db.getDb().collection("users");
    await users.insertOne({ uuid: "u-1", email: "a@example.com" });
    await expect(
      users.insertOne({ uuid: "u-2", email: "a@example.com" }),
    ).rejects.toMatchObject({ code: 11000 });
  });
});
