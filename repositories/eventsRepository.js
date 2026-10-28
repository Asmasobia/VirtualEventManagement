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
//    capacity, organizerName, createdAt,
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
//  participant list in the same document as the capacity, so one atomic update
//  can enforce both registration rules (no duplicates, no overbooking) with no
//  transaction. See addParticipant.
// ─────────────────────────────────────────────────────────────────────────────

const { randomUUID } = require("crypto");
const { getDb } = require("../db/client");

/**
 * Thrown by `addParticipant` when the event has no places left. A domain
 * error, so the route answers 409 by checking a type it owns.
 *
 * There is no "already registered" error. A repeat registration is not a
 * failure: see addParticipant.
 */
class EventFullError extends Error {
  constructor() {
    super("This event is full.");
    this.name = "EventFullError";
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
    capacity: doc.capacity,
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
 * string can never be stored here and sort wrongly later. `capacity` is a
 * positive integer, also validated by the route. A missing capacity would
 * make the event permanently full (see addParticipant), not unlimited.
 */
async function create({
  title,
  description,
  startsAt,
  capacity,
  organizerId,
  organizerName,
}) {
  const now = new Date();
  const doc = {
    uuid: randomUUID(),
    title,
    description,
    startsAt,
    capacity,
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
 * Register a user. Resolves to `{ event, created }`, or null if there is no
 * such event; rejects with EventFullError if there is no place left.
 *
 * `created` is false when the user was ALREADY registered. That is a success,
 * not an error: registration is idempotent, so a client whose response got
 * lost can retry and get the same answer, not a 409 for something that
 * actually worked. The caller uses `created` to avoid doing the side effects
 * (the confirmation email) twice.
 *
 * ONE conditional update, not read-check-write. The filter matches the event
 * only if BOTH rules hold: this user is not already a participant, and there
 * are fewer participants than `capacity`. The update pushes the user. MongoDB
 * evaluates the filter and applies the update to a single document atomically,
 * so of any number of concurrent requests, only as many as there are free
 * places can match. The rest match nothing. A version of this that read the
 * event, checked the count, then pushed would let every concurrent request
 * pass the check before any of them pushed. That is overbooking, and it is the
 * bug the concurrency tests exist to catch.
 *
 * `$expr` is needed because the limit is another field of the same document,
 * and a plain query can only compare a field to a constant. It does not cost
 * an index: the `uuid` condition finds the single document through its unique
 * index, and `$expr` is then checked against that one document only.
 *
 * An event stored without a `capacity` (none can be created that way now) has
 * a missing field, which sorts below every number, so it reads as full. That
 * fails closed: an event with no recorded limit takes no new registrations
 * instead of taking unlimited ones.
 */
async function addParticipant(eventId, { userId, name, email }) {
  const participant = {
    userUuid: userId,
    name,
    email,
    registeredAt: new Date(),
  };

  const doc = await collection().findOneAndUpdate(
    {
      uuid: eventId,
      "participants.userUuid": { $ne: userId },
      $expr: { $lt: [{ $size: "$participants" }, "$capacity"] },
    },
    {
      $push: { participants: participant },
      $set: { updatedAt: participant.registeredAt },
    },
    { returnDocument: "after" },
  );
  if (doc) return { event: toDomain(doc), created: true };

  // Matched nothing, so one of three things is true: the event does not exist,
  // the user is already on it, or it is full. The update cannot say which, so
  // this read finds out. It only decides what to REPORT. Every rule was already
  // enforced by the update above, so nothing that happens between the two calls
  // can let a duplicate or an extra participant in.
  //
  // "Already registered" is checked before "full" on purpose. A full event the
  // user is already on is a success for them: their retry must get a 200.
  //
  // One case reads wrongly, and it is acceptable. If somebody unregisters
  // between the update and this read, the event is full at the moment the
  // update ran but has a free place now, and this reports full anyway. That
  // was true when the decision was made, and a retry would succeed.
  const current = toDomain(await collection().findOne({ uuid: eventId }));
  if (!current) return null;
  if (current.participants.some((p) => p.userId === userId)) {
    return { event: current, created: false };
  }
  throw new EventFullError();
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
  EventFullError,
};
