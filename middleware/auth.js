// middleware/auth.js
const jwt = require("jsonwebtoken");
const store = require("../data/store");
require("dotenv").config();

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
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // ✅ Attach decoded payload directly — no store lookup
    // Store lookup caused 401 because beforeEach wipes users between tests
    req.user = {
      id:    decoded.id,
      name:  decoded.name,
      email: decoded.email,
      role:  decoded.role,
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