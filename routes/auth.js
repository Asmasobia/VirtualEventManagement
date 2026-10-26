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
// Duplicated security code is how two code paths drift: the day an `iss` claim or
// a token version is added, one of the two copies gets missed, and the bug is a
// silent authorization hole rather than a failing test.
//
// ⚠️ NOTE WHAT GOES IN THE PAYLOAD, because a JWT is signed, NOT encrypted. The
//    payload is base64url — not encryption — so anyone holding the token can read
//    every field in it, including the user themselves and anything that logs an
//    Authorization header. Name and email are already visible to their owner, so
//    they are acceptable here; a password hash, an internal flag, or another
//    user's data would not be.
function issueToken(user) {
  return jwt.sign(
    { id: user.id, name: user.name, email: user.email, role: user.role },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn },
  );
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

    const token = issueToken(newUser);

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

    const { user } = credentials;
    const token = issueToken(user);

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
router.get("/profile", authenticate, async (req, res) => {
  // Now async, so it needs the same try/catch as its siblings. Express 5 would
  // forward a rejection to the error handler anyway, but that answers with the
  // generic shape; this keeps /profile's failure response matching /login's.
  try {
    const user = await users.findById(req.user.id);

    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found." });
    }

    return res.status(200).json({ success: true, user });
  } catch (error) {
    console.error("Profile error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error." });
  }
});

module.exports = router;
