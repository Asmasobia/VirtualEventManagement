const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const router = express.Router();
const users = require("../repositories/usersRepository");
const { authenticate } = require("../middleware/auth");
const { sendWelcomeEmail } = require("../services/emailService");
const { isValidEmail, isValidPassword } = require("../utils/validator");
const config = require("../config/env");

// ─────────────────────────────────────────────
//  Token minting, in one place
// ─────────────────────────────────────────────
// Extracted because /register and /login had byte-identical `jwt.sign` calls.
// Duplicated security code is how two code paths drift: the day an `iss` claim is
// added, one of the two copies gets missed, and the bug is a silent authorization
// hole rather than a failing test.
//
// The payload is two claims and nothing else:
//   sub — the user's public id, the standard claim for "who this token is about".
//   ver — the user's tokenVersion at signing; bumping it revokes this token.
//
// Role, name and email used to be in here too. They are gone because
// authentication now reads them from the database on every request (see
// middleware/auth.js), and a copy in the token is a copy that goes stale: a role
// in a token is exactly the claim that outlives a demotion. Removing them also
// matters because a JWT is signed, NOT encrypted. The payload is base64url, so
// anyone holding the token, or anything that logs an Authorization header, can
// read every field in it. The less it carries, the less it leaks.
function issueToken(user, tokenVersion) {
  return jwt.sign({ sub: user.id, ver: tokenVersion }, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn,
  });
}

// ─────────────────────────────────────────────
//  POST /register
// ─────────────────────────────────────────────
router.post("/register", async (req, res) => {
  try {
    const { name, email, password, role = "attendee" } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: "Name, email and password are required.",
      });
    }

    if (!isValidEmail(email)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid email format." });
    }

    const passwordCheck = isValidPassword(password);
    if (!passwordCheck.valid) {
      return res
        .status(400)
        .json({ success: false, message: passwordCheck.message });
    }

    if (!["organizer", "attendee"].includes(role)) {
      return res.status(400).json({
        success: false,
        message: "Role must be either 'organizer' or 'attendee'.",
      });
    }

    // No "does this email exist?" lookup first — that was a check-then-write
    // race. The insert itself is the check: the unique index rejects a
    // duplicate atomically, and the repository turns that into EmailTakenError.
    //
    // The cost of that ordering: a duplicate registration now pays for a bcrypt
    // hash (~250 ms at cost 12) before being rejected. Acceptable — it is the
    // rare path, and a pre-check to skip the hash would only be an
    // optimisation, never the enforcement.
    const passwordHash = await bcrypt.hash(password, 12);

    let newUser;
    try {
      newUser = await users.create({ name, email, passwordHash, role });
    } catch (err) {
      if (err instanceof users.EmailTakenError) {
        return res.status(409).json({ success: false, message: err.message });
      }
      throw err;
    }

    // Fire-and-forget, deliberately not awaited: a slow or dead SMTP server
    // must not make registration slow or fail. The user's account already
    // exists at this point, so blocking on a courtesy email would turn an
    // optional feature into a hard dependency of the critical path.
    //
    // The `.catch()` is mandatory rather than tidy — an un-awaited promise
    // that rejects with no handler is an unhandledRejection, and server.js now
    // exits the process on those. A missing welcome email must not take the
    // server down.
    sendWelcomeEmail(newUser).catch((err) =>
      console.error("Welcome email failed:", err.message),
    );

    const token = issueToken(newUser, users.INITIAL_TOKEN_VERSION);

    // No hash to strip: the repository never returns it outside
    // findCredentialsByEmail, so `newUser` is safe to send as-is.
    return res.status(201).json({
      success: true,
      message: "Registration successful!",
      token,
      user: newUser,
    });
  } catch (error) {
    console.error("Registration error", error);
    return res.status(500).json({
      success: false,
      message: "An error occurred during registration.",
    });
  }
});

// ─────────────────────────────────────────────
//  POST /login
// ─────────────────────────────────────────────
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res
        .status(400)
        .json({ success: false, message: "Email and password are required." });
    }

    const credentials = await users.findCredentialsByEmail(email);

    if (!credentials) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid email or password." });
    }

    const isPasswordValid = await bcrypt.compare(
      password,
      credentials.passwordHash,
    );
    if (!isPasswordValid) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid email or password." });
    }

    const { user, tokenVersion } = credentials;
    const token = issueToken(user, tokenVersion);

    return res.status(200).json({
      success: true,
      message: "Login successful.",
      token,
      user,
    });
  } catch (error) {
    console.error("Login error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error." });
  }
});

// ─────────────────────────────────────────────
//  GET /profile
// ─────────────────────────────────────────────
router.get("/profile", authenticate, (req, res) => {
  // `authenticate` has just read this user from the database, so `req.user` is
  // the current record, not a token's copy of it. A second lookup would only
  // repeat the first.
  return res.status(200).json({ success: true, user: req.user });
});

// ─────────────────────────────────────────────
//  POST /logout-all
// ─────────────────────────────────────────────
// Revokes every token this user holds, including the one making the request. "All"
// rather than "this device" because stateless tokens can only be revoked as a
// group: the version is per user, not per token. Revoking one device would need a
// stored token id per session, a server-side list, which is the thing JWTs were
// chosen to avoid.
//
// This is also the mechanism a password change or account disable would call when
// those exist. They must revoke existing sessions too, or a stolen token outlives
// the password reset meant to lock the thief out.
router.post("/logout-all", authenticate, async (req, res) => {
  try {
    await users.revokeTokens(req.user.id);

    return res.status(200).json({
      success: true,
      message: "Logged out of all sessions.",
    });
  } catch (error) {
    console.error("Logout-all error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error." });
  }
});

module.exports = router;
