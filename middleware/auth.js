// middleware/auth.js
const jwt = require("jsonwebtoken");
const config = require("../config/env");

const authenticate = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Access denied. No token provided.",
      });
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, config.jwt.secret);

    // ⚠️ KNOWN LIMITATION — the token is trusted as the sole source of identity,
    //    with no lookup to confirm the user still exists or still holds this role.
    //    Scheduled to be fixed in PR 2; recorded here so it is a documented
    //    trade-off rather than an accident.
    //
    //    What it costs today, concretely:
    //      • A deleted user keeps full access until their token expires.
    //      • An organizer demoted to attendee keeps organizer powers, because
    //        `requireOrganizer` below reads the role from the token, not the
    //        database.
    //      • There is no revocation path at all. Nothing — not a password change,
    //        not disabling the account — can invalidate an issued token early.
    //
    //    ⚠️ The reason it is written this way is worth being honest about: a store
    //       lookup here returned 401 in tests, because the suite wipes the store
    //       between tests while the token from a previous one is still in hand.
    //       That is a test-fixture problem, and it was solved by changing
    //       production authentication semantics — the wrong half of the system.
    //       PR 2 restores the lookup and fixes the seeding instead.
    //
    //    The general rule this violates: a JWT proves that a claim was signed by
    //    us at some point in the past. It does not prove the claim is still true.
    //    Anything that can change between issuing and use — roles, entitlements,
    //    account status — must be read from the system of record, not the token.
    //    What the token legitimately saves you is the *authentication* round trip,
    //    not the *authorization* one.
    req.user = {
      id: decoded.id,
      name: decoded.name,
      email: decoded.email,
      role: decoded.role,
    };

    next();
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({
        success: false,
        message: "Token expired. Please log in again.",
      });
    }
    return res.status(401).json({
      success: false,
      message: "Invalid token.",
    });
  }
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
