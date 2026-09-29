const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { randomUUID: uuidv4 } = require("crypto");
const router = express.Router();
const store = require("../data/store");
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

    const existingUser = store.users.find(
      (u) => u.email.toLowerCase() === email.toLowerCase(),
    );
    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: "A user with this email already exists.",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const newUser = {
      id: uuidv4(),
      name: name.trim(),
      email: email.toLowerCase().trim(),
      password: hashedPassword,
      role,
      createdAt: new Date().toISOString(),
    };

    store.users.push(newUser);

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

    // Strip the hash before responding. `password: _` renames it out of the
    // rest object; the underscore is the convention for "deliberately unused".
    const { password: _hash, ...userResponse } = newUser;
    return res.status(201).json({
      success: true,
      message: "Registration successful!",
      token,
      user: userResponse,
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

    const user = store.users.find(
      (u) => u.email.toLowerCase() === email.toLowerCase(),
    );

    if (!user) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid email or password." });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid email or password." });
    }

    const token = issueToken(user);

    const { password: _hash, ...userResponse } = user;
    return res.status(200).json({
      success: true,
      message: "Login successful.",
      token,
      user: userResponse,
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
  const user = store.users.find((u) => u.id === req.user.id);

  if (!user) {
    return res.status(404).json({ success: false, message: "User not found." });
  }

  // Same hash-stripping idiom as /register and /login — `_hash` names the
  // extracted field only so it can be excluded from `userResponse`, and the
  // leading underscore tells both the reader and the linter that never reading
  // it is the intent rather than an oversight.
  const { password: _hash, ...userResponse } = user;
  return res.status(200).json({ success: true, user: userResponse });
});

module.exports = router;
