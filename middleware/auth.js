// middleware/auth.js
const jwt = require("jsonwebtoken");
const config = require("../config/env");
const users = require("../repositories/usersRepository");

// ─────────────────────────────────────────────
//  Authentication: the token says who, the database says what
// ─────────────────────────────────────────────
// A JWT proves that a claim was signed by us at some point in the past. It does not
// prove the claim is still true. So the token is used only for the part it can
// answer — "which user is this?" — and everything that can change after issue is
// read from the system of record on every request:
//
//   • The user must still exist. A deleted account's tokens stop working at once,
//     not when they expire.
//   • `req.user` (role included) comes from the database. A demoted organizer loses
//     organizer powers on their next request, because `requireOrganizer` below now
//     reads a role nobody can have cached in a token.
//   • The token's version must equal the user's current one. Incrementing it
//     (`users.revokeTokens`) invalidates every token issued before, on every device.
//     That is the whole revocation mechanism: one integer per user, no token list.
//
// The cost is one indexed read per authenticated request. It is the right trade:
// what a signed token legitimately saves is the *authentication* round trip
// (no session store, no password check), not the *authorization* one.
//
// This used to trust the payload and skip the lookup, because a lookup broke tests
// whose fixtures wiped the users a token referred to. That was a fixture problem
// solved by weakening production auth; the fixtures now create real users instead.

// One message for every rejected token — forged, malformed, revoked, or belonging to
// a deleted user. Distinct messages would let anyone holding an old token learn
// whether its account still exists or was deliberately revoked.
const INVALID_TOKEN = "Invalid token.";

function reject(res, message) {
  return res.status(401).json({ success: false, message });
}

const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return reject(res, "Access denied. No token provided.");
  }

  let claims;
  try {
    claims = jwt.verify(authHeader.split(" ")[1], config.jwt.secret);
  } catch (error) {
    // Expiry keeps its own message. Unlike revocation it reveals nothing: `exp` is
    // readable by anyone holding the token, and telling the client to log in again
    // is the useful answer.
    if (error.name === "TokenExpiredError") {
      return reject(res, "Token expired. Please log in again.");
    }
    return reject(res, INVALID_TOKEN);
  }

  // A correctly signed token from before versioning, or one minted with a different
  // payload shape, has no usable `sub`/`ver`. Rejected rather than defaulted: a
  // token with no version is a token that could never be revoked.
  if (typeof claims.sub !== "string" || !Number.isInteger(claims.ver)) {
    return reject(res, INVALID_TOKEN);
  }

  // Deliberately outside the try/catch above. If the database is unreachable this
  // throws, Express 5 forwards the rejection to the error handler, and the client
  // gets a 500. Answering 401 instead would tell every client its token is bad
  // during an outage, and a well-behaved client discards it and logs the user out.
  const session = await users.findSession(claims.sub);

  if (!session || session.tokenVersion !== claims.ver) {
    return reject(res, INVALID_TOKEN);
  }

  // `require-atomic-updates` sees `req` read before the await and written after it,
  // and warns that another task may have changed `req` in between. Not possible
  // here: `req` belongs to this one request, and nothing else in the middleware
  // chain runs until `next()` is called below. The rule stays on project-wide
  // because the pattern it catches is real for shared objects.
  // eslint-disable-next-line require-atomic-updates
  req.user = session.user;
  next();
};

const requireOrganizer = (req, res, next) => {
  if (req.user.role !== "organizer") {
    return res.status(403).json({
      success: false,
      message: "Access denied. Only organizers can perform this action.",
    });
  }
  next();
};

const requireAttendee = (req, res, next) => {
  if (req.user.role !== "attendee") {
    return res.status(403).json({
      success: false,
      message: "Access denied. Only attendees can register for events.",
    });
  }
  next();
};

module.exports = { authenticate, requireOrganizer, requireAttendee };
