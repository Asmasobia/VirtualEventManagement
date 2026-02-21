const express = require("express");
const { randomUUID: uuidv4 } = require("crypto");
const router = express.Router();
const store = require("../data/store");
const { authenticate, requireOrganizer } = require("../middleware/auth");
const {
  sendEventRegistrationEmail,
  sendEventUpdateEmail,
} = require("../services/emailService");
const { isFutureDate } = require("../utils/validator");

// ─────────────────────────────────────────────
//  HELPER: Simplified event response
// ─────────────────────────────────────────────
const formatEvent = (event) => ({
  id:             event.id,
  title:          event.title,
  description:    event.description,
  date:           event.date,
  time:           event.time,
  organizerName:  event.organizerName,
  participantCount: event.participants.length,
});

// ─────────────────────────────────────────────
//  GET /events  – List all events
// ─────────────────────────────────────────────
router.get("/", (req, res) => {
  try {
    let events = [...store.events];
    const { upcoming, organizerId, search } = req.query;

    if (upcoming === "true") {
      events = events.filter((e) => new Date(e.date) > new Date());
    }

    if (organizerId) {
      events = events.filter((e) => e.organizerId === organizerId);
    }

    if (search) {
      const keyword = search.toLowerCase();
      events = events.filter(
        (e) =>
          e.title.toLowerCase().includes(keyword) ||
          e.description.toLowerCase().includes(keyword)
      );
    }

    events.sort((a, b) => new Date(a.date) - new Date(b.date));

    return res.status(200).json({
      success: true,
      count:   events.length,
      events:  events.map(formatEvent),
    });
  } catch (error) {
    console.error("Get events error:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
});

// ─────────────────────────────────────────────
//  GET /events/:id  – Get single event
// ─────────────────────────────────────────────
router.get("/:id", (req, res) => {
  try {
    const event = store.events.find((e) => e.id === req.params.id);

    if (!event) {
      return res.status(404).json({ success: false, message: "Event not found." });
    }

    return res.status(200).json({
      success: true,
      event:   formatEvent(event),
    });
  } catch (error) {
    console.error("Get event error:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
});

// ─────────────────────────────────────────────
//  POST /events  – Create event (organizer only)
// ─────────────────────────────────────────────
router.post("/", authenticate, requireOrganizer, (req, res) => {
  try {
    const { title, description, date, time } = req.body;

    console.log("CREATE EVENT - req.user :", req.user);
    console.log("CREATE EVENT - req.body :", req.body);

    if (!title || !description || !date || !time) {
      return res.status(400).json({
        success: false,
        message: "Title, description, date, and time are required.",
      });
    }

    if (!isFutureDate(date)) {
      return res.status(400).json({
        success: false,
        message: "Event date must be in the future.",
      });
    }

    const newEvent = {
      id:            uuidv4(),
      title:         title.trim(),
      description:   description.trim(),
      date,
      time,
      organizerId:   req.user.id,
      organizerName: req.user.name,
      participants:  [],
      createdAt:     new Date().toISOString(),
      updatedAt:     new Date().toISOString(),
    };

    store.events.push(newEvent);

    console.log("CREATE EVENT - newEvent :", newEvent);

    return res.status(201).json({
      success: true,
      message: "Event created successfully.",
      event:   formatEvent(newEvent),
    });
  } catch (error) {
    console.error("Create event error:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
});

// ─────────────────────────────────────────────
//  PUT /events/:id  – Update event (organizer only)
// ─────────────────────────────────────────────
router.put("/:id", authenticate, requireOrganizer, async (req, res) => {
  try {
    const eventIndex = store.events.findIndex((e) => e.id === req.params.id);

    if (eventIndex === -1) {
      return res.status(404).json({ success: false, message: "Event not found." });
    }

    const event = store.events[eventIndex];

    if (event.organizerId !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: "Access denied. You can only update your own events.",
      });
    }

    const { title, description, date, time } = req.body;

    if (date && !isFutureDate(date)) {
      return res.status(400).json({
        success: false,
        message: "Event date must be in the future.",
      });
    }

    const updatedEvent = {
      ...event,
      title:       title       ? title.trim()       : event.title,
      description: description ? description.trim() : event.description,
      date:        date        || event.date,
      time:        time        || event.time,
      updatedAt:   new Date().toISOString(),
    };

    store.events[eventIndex] = updatedEvent;

    if (updatedEvent.participants.length > 0) {
      sendEventUpdateEmail(updatedEvent.participants, updatedEvent).catch((err) =>
        console.error("Update notification error:", err.message)
      );
    }

    return res.status(200).json({
      success: true,
      message: "Event updated successfully.",
      event:   formatEvent(updatedEvent),
    });
  } catch (error) {
    console.error("Update event error:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
});

// ─────────────────────────────────────────────
//  DELETE /events/:id  – Delete event (organizer only)
// ─────────────────────────────────────────────
router.delete("/:id", authenticate, requireOrganizer, (req, res) => {
  try {
    const eventIndex = store.events.findIndex((e) => e.id === req.params.id);

    if (eventIndex === -1) {
      return res.status(404).json({ success: false, message: "Event not found." });
    }

    const event = store.events[eventIndex];

    if (event.organizerId !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: "Access denied. You can only delete your own events.",
      });
    }

    store.events.splice(eventIndex, 1);

    store.users.forEach((user) => {
      user.registeredEvents = user.registeredEvents.filter(
        (id) => id !== req.params.id
      );
    });

    return res.status(200).json({
      success: true,
      message: "Event deleted successfully.",
    });
  } catch (error) {
    console.error("Delete event error:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
});

// ─────────────────────────────────────────────
//  POST /events/:id/register  – Register for event
// ─────────────────────────────────────────────
router.post("/:id/register", authenticate, async (req, res) => {
  try {
    const eventIndex = store.events.findIndex((e) => e.id === req.params.id);

    if (eventIndex === -1) {
      return res.status(404).json({ success: false, message: "Event not found." });
    }

    const event = store.events[eventIndex];

    if (req.user.role === "organizer") {
      return res.status(403).json({
        success: false,
        message: "Organizers cannot register as attendees for events.",
      });
    }

    if (new Date(event.date) < new Date()) {
      return res.status(400).json({
        success: false,
        message: "Cannot register for a past event.",
      });
    }

    const alreadyRegistered = event.participants.some(
      (p) => p.userId === req.user.id
    );
    if (alreadyRegistered) {
      return res.status(409).json({
        success: false,
        message: "You are already registered for this event.",
      });
    }

    const participant = {
      userId:       req.user.id,
      name:         req.user.name,
      email:        req.user.email,
      registeredAt: new Date().toISOString(),
    };

    store.events[eventIndex].participants.push(participant);
    store.events[eventIndex].updatedAt = new Date().toISOString();

    const userIndex = store.users.findIndex((u) => u.id === req.user.id);
    if (userIndex !== -1) {
      store.users[userIndex].registeredEvents.push(event.id);
    }

    const fullUser = store.users.find((u) => u.id === req.user.id);
    sendEventRegistrationEmail(fullUser, event).catch((err) =>
      console.error("Confirmation email error:", err.message)
    );

    return res.status(200).json({
      success: true,
      message: `Successfully registered for "${event.title}".`,
      registration: {
        eventId:      event.id,
        eventTitle:   event.title,
        eventDate:    event.date,
        eventTime:    event.time,
        registeredAt: participant.registeredAt,
      },
    });
  } catch (error) {
    console.error("Event registration error:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
});

// ─────────────────────────────────────────────
//  DELETE /events/:id/register  – Unregister from event
// ─────────────────────────────────────────────
router.delete("/:id/register", authenticate, (req, res) => {
  try {
    const eventIndex = store.events.findIndex((e) => e.id === req.params.id);

    if (eventIndex === -1) {
      return res.status(404).json({ success: false, message: "Event not found." });
    }

    const event = store.events[eventIndex];

    const participantIndex = event.participants.findIndex(
      (p) => p.userId === req.user.id
    );

    if (participantIndex === -1) {
      return res.status(404).json({
        success: false,
        message: "You are not registered for this event.",
      });
    }

    store.events[eventIndex].participants.splice(participantIndex, 1);
    store.events[eventIndex].updatedAt = new Date().toISOString();

    const userIndex = store.users.findIndex((u) => u.id === req.user.id);
    if (userIndex !== -1) {
      store.users[userIndex].registeredEvents = store.users[
        userIndex
      ].registeredEvents.filter((id) => id !== req.params.id);
    }

    return res.status(200).json({
      success: true,
      message: "Successfully unregistered from the event.",
    });
  } catch (error) {
    console.error("Unregister error:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
});

// ─────────────────────────────────────────────
//  GET /events/:id/participants  – View participants (organizer only)
// ─────────────────────────────────────────────
router.get("/:id/participants", authenticate, requireOrganizer, (req, res) => {
  try {
    console.log("PARTICIPANTS - req.user    :", req.user);
    console.log("PARTICIPANTS - req.params  :", req.params);
    console.log("PARTICIPANTS - store.events:", store.events.length);

    const event = store.events.find((e) => e.id === req.params.id);

    console.log("PARTICIPANTS - event found :", event);

    if (!event) {
      return res.status(404).json({ success: false, message: "Event not found." });
    }

    if (event.organizerId !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: "Access denied. You can only view participants for your own events.",
      });
    }

    return res.status(200).json({
      success:          true,
      eventTitle:       event.title,
      participantCount: event.participants.length,
      participants:     event.participants,
    });
  } catch (error) {
    console.error("Get participants error:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
});

module.exports = router;