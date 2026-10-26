// ─────────────────────────────────────────────────────────────────────────────
//  USERS REPOSITORY: the only code that knows how a user is stored.
//
//  Routes call these functions with plain values and get plain objects back. They
//  never see the driver, a filter document, an `ObjectId`, or a Mongo error code.
//  That boundary is what makes the storage engine swappable, and it is also what
//  keeps the routes readable: "find the user with this email" rather than
//  "build this query, then strip these internal fields".
//
//  Two shapes, and the mapping between them lives here only:
//
//    stored (Mongo)                 domain (what callers get)
//    ─────────────                  ─────────────────────────
//    _id: ObjectId                  — never leaves this file
//    uuid: "…"                      id: "…"        the public identifier
//    email, name, role              email, name, role
//    passwordHash                   — only via findCredentialsByEmail
//    tokenVersion: number           — only via findCredentialsByEmail / findSession
//    createdAt: Date                createdAt: Date (serialises to ISO-8601)
//
//  The hash is withheld by default rather than stripped by each route. The old
//  routes each destructured `password` out before responding, which works until
//  the first new route forgets to — and that bug is a credential leak, not a
//  failing test. Now the only way to get the hash is a function whose name says
//  so, and the only caller is login.
//
//  `_id` stays internal on purpose. The API has always returned uuid strings; a
//  change of public identifier format would be a breaking change, and tying the
//  public id to the storage engine's own key type would make the engine harder,
//  not easier, to replace.
// ─────────────────────────────────────────────────────────────────────────────

const { randomUUID } = require("crypto");
const { getDb } = require("../db/client");

// MongoDB's code for a unique index rejecting a write.
const DUPLICATE_KEY = 11000;

/**
 * Thrown by `create` when the email is already registered. A domain error, so the
 * route can answer 409 by checking a type it owns instead of a driver error code.
 */
class EmailTakenError extends Error {
  constructor() {
    super("A user with this email already exists.");
    this.name = "EmailTakenError";
  }
}

// Every issued token carries the user's tokenVersion, and authentication rejects a
// token whose version no longer matches. Incrementing the stored number therefore
// revokes every token issued before it, on every device, without keeping a
// server-side list of tokens. Exported so /register can sign a new account's first
// token without a second read.
const INITIAL_TOKEN_VERSION = 0;

// Looked up per call rather than captured at require time: the client connects
// after modules load, and the test harness drops and recreates the database.
function collection() {
  return getDb().collection("users");
}

// Emails are compared case-insensitively. Normalising on the way IN (both on
// write and on lookup) is what lets a plain unique index enforce that — the index
// compares bytes, so "A@x.com" and "a@x.com" must already be the same string by
// the time they reach it. Doing this here rather than in each route means there is
// one place the rule can be got wrong instead of three.
function normaliseEmail(email) {
  return email.trim().toLowerCase();
}

// An explicit field list rather than "everything except _id": a field added to the
// stored document later is not exposed to callers until someone adds it here.
function toDomain(doc) {
  if (!doc) return null;
  return {
    id: doc.uuid,
    name: doc.name,
    email: doc.email,
    role: doc.role,
    createdAt: doc.createdAt,
  };
}

/**
 * Insert a new user and return it. Rejects with EmailTakenError on a duplicate.
 *
 * There is deliberately no "does this email exist?" query first. Check-then-insert
 * is a race: two concurrent registrations both see "no", and both insert. The
 * unique index on `email` makes the second insert fail inside the database,
 * atomically, so the database's answer is the only one worth asking for.
 */
async function create({ name, email, passwordHash, role }) {
  const doc = {
    uuid: randomUUID(),
    name: name.trim(),
    email: normaliseEmail(email),
    passwordHash,
    role,
    tokenVersion: INITIAL_TOKEN_VERSION,
    createdAt: new Date(),
  };

  try {
    // insertOne adds `_id` to `doc` in place; toDomain drops it again.
    await collection().insertOne(doc);
  } catch (err) {
    // Checking WHICH index fired, not just the code: a uuid collision is not
    // "email taken", and reporting it as one would hide a real bug.
    if (err.code === DUPLICATE_KEY && err.keyPattern?.email) {
      throw new EmailTakenError();
    }
    throw err;
  }

  return toDomain(doc);
}

/**
 * For login only: the user with this email (case-insensitive), their password hash
 * and their current token version, or null. Kept separate from findById so that
 * reading a user and reading a credential are different calls.
 */
async function findCredentialsByEmail(email) {
  const doc = await collection().findOne({ email: normaliseEmail(email) });
  if (!doc) return null;
  return {
    user: toDomain(doc),
    passwordHash: doc.passwordHash,
    tokenVersion: doc.tokenVersion,
  };
}

/** The user with this public id, or null. */
async function findById(id) {
  return toDomain(await collection().findOne({ uuid: id }));
}

/**
 * For authentication only: the user with this public id plus their current token
 * version, or null. Called on every authenticated request, which is why it is one
 * read on the unique `uuid` index and nothing more.
 */
async function findSession(id) {
  const doc = await collection().findOne({ uuid: id });
  if (!doc) return null;
  return { user: toDomain(doc), tokenVersion: doc.tokenVersion };
}

/**
 * Invalidate every token this user holds. Returns false if there is no such user.
 *
 * `$inc` rather than read-add-one-write: the increment happens inside the
 * database, so two concurrent revocations cannot both read N and both write N+1,
 * which would leave a token signed at N+1 by a login in between still valid.
 */
async function revokeTokens(id) {
  const result = await collection().updateOne(
    { uuid: id },
    { $inc: { tokenVersion: 1 } },
  );
  return result.matchedCount === 1;
}

module.exports = {
  create,
  findCredentialsByEmail,
  findById,
  findSession,
  revokeTokens,
  INITIAL_TOKEN_VERSION,
  EmailTakenError,
};
