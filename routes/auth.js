const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { randomUUID: uuidv4 } = require("crypto");
const router = express.Router();
const store = require("../data/store");
const { authenticate } = require("../middleware/auth");
const { sendWelcomeEmail } = require("../services/emailService");
const { isValidEmail, isValidPassword } = require("../utils/validator");
require("dotenv").config();

// ─────────────────────────────────────────────
//  POST /register
// ─────────────────────────────────────────────
router.post("/register", async (req, res) => {
    try {
        const { name, email, password, role = "attendee" } = req.body;

        if (!name || !email || !password) {
            return res.status(400).json({ success: false, message: "Name, email and password are required." });
        }

        if (!isValidEmail(email)) {
            return res.status(400).json({ success: false, message: "Invalid email format." });
        }

        const passwordCheck = isValidPassword(password);
        if (!passwordCheck.valid) {
            return res.status(400).json({ success: false, message: passwordCheck.message });
        }

        if (!["organizer", "attendee"].includes(role)) {
            return res.status(400).json({ success: false, message: "Role must be either 'organizer' or 'attendee'." });
        }

        const existingUser = store.users.find(
            (u) => u.email.toLowerCase() === email.toLowerCase()
        );
        if (existingUser) {
            return res.status(409).json({ success: false, message: "A user with this email already exists." });
        }

        const hashedPassword = await bcrypt.hash(password, 12);

        const newUser = {
            id:               uuidv4(),
            name:             name.trim(),
            email:            email.toLowerCase().trim(),
            password:         hashedPassword,
            role,
            createdAt:        new Date().toISOString(),
            registeredEvents: [],
        };

        store.users.push(newUser); // ✅ fixed: store.users not store

        sendWelcomeEmail(newUser).catch((err) =>
            console.error("Email error:", err.message)
        );

        const token = jwt.sign(
            { id: newUser.id, name: newUser.name, email: newUser.email, role: newUser.role },
            process.env.JWT_SECRET,
            { expiresIn: process.env.JWT_EXPIRES_IN }
        );

        const { password: _, ...userResponse } = newUser;
        return res.status(201).json({
            success: true,
            message: "Registration successful!",
            token,
            user: userResponse,
        });

    } catch (error) {
        console.error("Registration error", error);
        return res.status(500).json({ success: false, message: "An error occurred during registration." });
    }
});

// ─────────────────────────────────────────────
//  POST /login
// ─────────────────────────────────────────────
router.post("/login", async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ success: false, message: "Email and password are required." });
        }

        const user = store.users.find(
            (u) => u.email.toLowerCase() === email.toLowerCase()
        );

        if (!user) {
            return res.status(401).json({ success: false, message: "Invalid email or password." });
        }

        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (!isPasswordValid) {
            return res.status(401).json({ success: false, message: "Invalid email or password." });
        }

        const token = jwt.sign(
            { id: user.id, name: user.name, email: user.email, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: process.env.JWT_EXPIRES_IN }
        );

        const { password: _, ...userResponse } = user;
        return res.status(200).json({
            success: true,
            message: "Login successful.",
            token,
            user: userResponse,
        });

    } catch (error) {
        console.error("Login error:", error);
        return res.status(500).json({ success: false, message: "Internal server error." });
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

    const { password, ...userResponse } = user;
    return res.status(200).json({ success: true, user: userResponse });
});

module.exports = router;