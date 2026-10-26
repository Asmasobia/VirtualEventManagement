const db = require("../db/client");
const users = require("../repositories/usersRepository");
const { useTestDatabase } = require("./helpers/db");

// The routes rely on three promises from this module: no password hash and no
// storage internals leak out by default, email matching is case-insensitive,
// and a duplicate email arrives as a domain error rather than a driver one.
// Each is checked here directly, against the real database.

useTestDatabase();

const alice = {
  name: "  Alice  ",
  email: "Alice@Example.com",
  passwordHash: "not-a-real-hash",
  role: "attendee",
};

describe("usersRepository", () => {
  it("returns a domain object: public id, no _id, no hash", async () => {
    const user = await users.create(alice);

    expect(user).toEqual({
      id: expect.any(String),
      name: "Alice",
      email: "alice@example.com",
      role: "attendee",
      createdAt: expect.any(Date),
    });
  });

  it("stores the public id as `uuid` and keeps `_id` internal", async () => {
    const user = await users.create(alice);
    const doc = await db.getDb().collection("users").findOne({ uuid: user.id });

    expect(doc).not.toBeNull();
    expect(doc._id).toBeDefined();
    expect(doc._id.toString()).not.toBe(user.id);
  });

  it("finds by id without exposing the hash", async () => {
    const created = await users.create(alice);
    expect(await users.findById(created.id)).toEqual(created);
  });

  it("returns null for an unknown id or email", async () => {
    expect(await users.findById("no-such-id")).toBeNull();
    expect(await users.findCredentialsByEmail("nobody@example.com")).toBeNull();
  });

  it("hands out the hash only through findCredentialsByEmail, case-insensitively", async () => {
    const created = await users.create(alice);
    const credentials = await users.findCredentialsByEmail("ALICE@example.COM");

    expect(credentials.user).toEqual(created);
    expect(credentials.passwordHash).toBe(alice.passwordHash);
  });

  it("rejects a duplicate email in any letter case with EmailTakenError", async () => {
    await users.create(alice);

    await expect(
      users.create({ ...alice, email: "ALICE@example.com" }),
    ).rejects.toBeInstanceOf(users.EmailTakenError);
  });

  // The race the old check-then-insert code had: both requests saw "no such
  // email" and both inserted. With the unique index as the only check, exactly
  // one of a burst of concurrent creates can win.
  it("lets exactly one of several concurrent duplicate registrations succeed", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => users.create(alice)),
    );

    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(4);
    for (const r of lost) {
      expect(r.reason).toBeInstanceOf(users.EmailTakenError);
    }
  });
});

describe("usersRepository token versions", () => {
  it("starts a new user at the initial version", async () => {
    const created = await users.create(alice);
    const session = await users.findSession(created.id);

    expect(session).toEqual({
      user: created,
      tokenVersion: users.INITIAL_TOKEN_VERSION,
    });
  });

  it("returns null for the session of an unknown id", async () => {
    expect(await users.findSession("no-such-id")).toBeNull();
  });

  it("gives login the same version authentication will check", async () => {
    const created = await users.create(alice);
    await users.revokeTokens(created.id);

    const credentials = await users.findCredentialsByEmail(alice.email);
    const session = await users.findSession(created.id);
    expect(credentials.tokenVersion).toBe(session.tokenVersion);
  });

  it("reports whether there was a user to revoke", async () => {
    const created = await users.create(alice);

    expect(await users.revokeTokens(created.id)).toBe(true);
    expect(await users.revokeTokens("no-such-id")).toBe(false);
  });

  // Read-add-one-write would lose increments here: several revocations reading
  // the same N and all writing N+1. `$inc` applies each one inside the database.
  it("counts every one of several concurrent revocations", async () => {
    const created = await users.create(alice);

    await Promise.all(
      Array.from({ length: 5 }, () => users.revokeTokens(created.id)),
    );

    const session = await users.findSession(created.id);
    expect(session.tokenVersion).toBe(users.INITIAL_TOKEN_VERSION + 5);
  });
});
