const express = require("express");
const app = express();
require("dotenv").config();

// ─── Middleware ───────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Basic request logger
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ─── Routes ───────────────────────────────────
const authRoutes = require("./routes/auth");
const eventRoutes = require("./routes/events");

app.use("/", authRoutes);         // POST /register, POST /login, GET /profile
app.use("/events", eventRoutes);  // GET/POST /events, PUT/DELETE /events/:id, etc.

// ─── Health Check ─────────────────────────────
app.get("/health", (req, res) => {
  res.status(200).json({
    success: true,
    message: "Virtual Event Platform API is running.",
    timestamp: new Date().toISOString(),
  });
});

// ─── 404 Handler ──────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.method} ${req.path} not found.`,
  });
});

// ─── Global Error Handler ─────────────────────
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({
    success: false,
    message: "An unexpected error occurred.",
  });
});

// ─── Start Server ─────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📋 Health check: http://localhost:${PORT}/health`);
});

module.exports = app;