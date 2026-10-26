// ─────────────────────────────────────────────────────────────────────────────
//  EVENTS REPOSITORY: the only code that knows how an event is stored.
//
//  Same contract as usersRepository: routes pass plain values in and get plain
//  objects back, and never see the driver, a filter document or an `ObjectId`.
//
//    stored (Mongo)                    domain (what callers get)
//    ─────────────                     ─────────────────────────
//    _id: ObjectId                     — never leaves this file
//    uuid                              id                the public identifier
//    organizerUuid                     organizerId
//    participants[].userUuid           participants[].userId
//    title, description, startsAt,     (unchanged)
//    organizerName, createdAt,
//    updatedAt, participants[].name,
//    participants[].email,
//    participants[].registeredAt
//
//  Why the stored names differ from the domain ones: inside the database a
//  reference to another document is stored as that document's `uuid`, and the
//  field says so. That is the name the multikey index on
//  `participants.userUuid` is built on, and the name you type into mongosh
//  to answer "what is this user registered for". The API has always said `id`
//  and `organizerId`, and changing that would be a breaking change, so the
//  mapping happens here and nowhere else.
//
//  Registrations stay EMBEDDED in the event (see CLAUDE.md). That puts the
//  participant list in the same document as everything a registration rule
//  needs, so one atomic update can enforce a rule with no transaction. See
//  addParticipant.
// ─────────────────────────────────────────────────────────────────────────────

const { randomUUID } = require("crypto");
const { getDb } = require("../db/client");

/**
 * Thrown by `addParticipant` when the user is already registered. A domain
 * error, so the route answers 409 by checking a type it owns.
 */
class AlreadyRegisteredError extends Error {
  constructor() {
    super("You are already registered for this event.");
    this.name = "AlreadyRegisteredError";
  }
}

// Looked up per call: the client connects after modules load, and the test
// harness drops and recreates the database between tests.
function collection() {
  return getDb().collection("events");
}

// Explicit field lists, as in usersRepository: a field added to the stored
// document is not exposed until someone adds it here on purpose.
function participantToDomain(p) {
  return {
    userId: p.userUuid,
    name: p.name,
    email: p.email,
    registeredAt: p.registeredAt,
  };
}

function toDomain(doc) {
  if (!doc) return null;
  return {
    id: doc.uuid,
    title: doc.title,
    description: doc.description,
    startsAt: doc.startsAt,
    organizerId: doc.organizerUuid,
    organizerName: doc.organizerName,
    participants: doc.participants.map(participantToDomain),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

// User input reaches a `$regex` here, so it is escaped first. Unescaped, a
// search for "(" or "[" is a regex syntax error from the server (a 500), "."
// matches every event, and a crafted pattern like "(a+)+$" can make the server
// backtrack for a long time on every document (ReDoS). Escaped, the input can
// only ever match itself, which is what "search" promised in the first place.
function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Insert a new event with no participants and return it. `startsAt` is a Date
 * (one UTC instant); parsing the client's string is the route's job, so a
 * string can never be stored here and sort wrongly later.
 */
async function create({
  title,
  description,
  startsAt,
  organizerId,
  organizerName,
}) {
  const now = new Date();
  const doc = {
    uuid: randomUUID(),
    title,
    description,
    startsAt,
    organizerUuid: organizerId,
    organizerName,
    participants: [],
    createdAt: now,
    updatedAt: now,
  };
  // insertOne adds `_id` to `doc` in place; toDomain drops it again.
  await collection().insertOne(doc);
  return toDomain(doc);
}

/** The event with this public id, or null. */
async function findById(id) {
  return toDomain(await collection().findOne({ uuid: id }));
}

/**
 * Events matching every filter given, soonest first.
 *
 * Every filter and the sort run in the database. That is possible because
 * `startsAt` is a real Date: BSON compares dates chronologically, where the old
 * `date` string ("2026-12-01") plus `time` string ("10:00 AM") could neither be
 * range-queried nor sorted correctly. No index backs the sort or the range
 * yet; that is a deliberate omission at this scale (see CLAUDE.md's index
 * table), and the first one to add if listing ever gets slow.
 */
async function list({ upcoming = false, organizerId, search } = {}) {
  const filter = {};

  // The typeof checks matter because these values come from the query string,
  // and anything that is not a plain string must not get into a filter document.
  // Express 5's default parser never builds objects (so `?organizerId[$ne]=x`
  // cannot become an operator), but a repeated key such as
  // `?organizerId=a&organizerId=b` does arrive as an array. Checking here
  // means the guarantee does not depend on how the app's parser is configured.
  if (typeof organizerId === "string") {
    filter.organizerUuid = organizerId;
  }

  if (typeof search === "string" && search !== "") {
    // Case-insensitive substring match, as before. An unanchored regex cannot
    // use an index, so this scans the collection. That is fine at this scale.
    // A `text` index is the scalable answer, but it matches whole words, not
    // substrings, so switching would change behaviour, not just speed.
    const pattern = { $regex: escapeRegex(search), $options: "i" };
    filter.$or = [{ title: pattern }, { description: pattern }];
  }

  if (upcoming) {
    filter.startsAt = { $gt: new Date() };
  }

  const docs = await collection().find(filter).sort({ startsAt: 1 }).toArray();
  return docs.map(toDomain);
}

/**
 * Apply `changes` (any of title, description, startsAt) and return the
 * updated event, or null if there is no such event.
 *
 * `$set` on just the named fields, rather than replacing the document with a
 * modified copy. A whole-document write would put back whatever the caller
 * had read, so a registration that landed between that read and this write
 * would be silently wiped out.
 */
async function update(id, changes) {
  const allowed = ["title", "description", "startsAt"];
  const $set = { updatedAt: new Date() };
  for (const field of allowed) {
    if (changes[field] !== undefined) $set[field] = changes[field];
  }

  const doc = await collection().findOneAndUpdate(
    { uuid: id },
    { $set },
    { returnDocument: "after" },
  );
  return toDomain(doc);
}

/** Delete the event, and with it every registration. True if one was deleted. */
async function remove(id) {
  const { deletedCount } = await collection().deleteOne({ uuid: id });
  return deletedCount === 1;
}

/**
 * Register a user and return the updated event. Returns null if there is no
 * such event; rejects with AlreadyRegisteredError if they are already on it.
 *
 * ONE conditional update, not read-check-write. The filter matches the event
 * only if this user is NOT already in its participants, and the update pushes
 * them. MongoDB applies the filter and the update to a single document
 * atomically, so of two concurrent identical requests exactly one can match.
 * The other matches nothing. The old code read the array, checked it, then
 * pushed, and both requests could pass the check before either pushed.
 *
 * PR 3 adds capacity by adding one more condition to the same filter (fewer
 * than N participants). Still one operation, still no transaction.
 */
async function addParticipant(eventId, { userId, name, email }) {
  const participant = {
    userUuid: userId,
    name,
    email,
    registeredAt: new Date(),
  };

  const doc = await collection().findOneAndUpdate(
    { uuid: eventId, "participants.userUuid": { $ne: userId } },
    {
      $push: { participants: participant },
      $set: { updatedAt: participant.registeredAt },
    },
    { returnDocument: "after" },
  );
  if (doc) return toDomain(doc);

  // Matched nothing. Either the event does not exist or the user is already
  // registered, and the update cannot say which. This read only picks the right
  // error message. It does not enforce anything, so the gap between the two
  // calls cannot let a duplicate in.
  const exists = await collection().countDocuments(
    { uuid: eventId },
    { limit: 1 },
  );
  if (!exists) return null;
  throw new AlreadyRegisteredError();
}

/**
 * Unregister a user. True if a registration was removed. False if there was
 * nothing to remove (no such event, or not registered for it).
 *
 * `$pull` is atomic for the same reason `$push` is above, so there is no
 * read-then-splice gap.
 */
async function removeParticipant(eventId, userId) {
  const { modifiedCount } = await collection().updateOne(
    { uuid: eventId, "participants.userUuid": userId },
    {
      $pull: { participants: { userUuid: userId } },
      $set: { updatedAt: new Date() },
    },
  );
  return modifiedCount === 1;
}

module.exports = {
  create,
  findById,
  list,
  update,
  remove,
  addParticipant,
  removeParticipant,
  AlreadyRegisteredError,
};
