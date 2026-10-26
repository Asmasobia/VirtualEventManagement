const express = require("express");
const router = express.Router();
const events = require("../repositories/eventsRepository");
const { authenticate, requireOrganizer } = require("../middleware/auth");
const {
  sendEventRegistrationEmail,
  sendEventUpdateEmail,
} = require("../services/emailService");
const { parseStartsAt } = require("../utils/validator");

// Validate a client-supplied `startsAt`. Returns { startsAt } on success or
// { error } with the message to send as a 400. One place, so create and update
// cannot drift apart on what counts as a valid start.
const checkStartsAt = (value) => {
  const startsAt = parseStartsAt(value);
  if (!startsAt) {
    return {
      error:
        "startsAt must be an ISO 8601 date-time with a UTC offset, " +
        'e.g. "2026-12-01T10:00:00Z".',
    };
  }
  if (startsAt <= new Date()) {
    return { error: "Event start must be in the future." };
  }
  return { startsAt };
};

// ─────────────────────────────────────────────
//  HELPER: Simplified event response
// ─────────────────────────────────────────────
const formatEvent = (event) => ({
  id: event.id,
  title: event.title,
  description: event.description,
  startsAt: event.startsAt,
  organizerName: event.organizerName,
  participantCount: event.participants.length,
});

// ─────────────────────────────────────────────
//  GET /events  – List all events
// ─────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const { upcoming, organizerId, search } = req.query;

    const found = await events.list({
      upcoming: upcoming === "true",
      organizerId,
      search,
    });

    return res.status(200).json({
      success: true,
      count: found.length,
      events: found.map(formatEvent),
    });
  } catch (error) {
    console.error("Get events error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error." });
  }
});

// ─────────────────────────────────────────────
//  GET /events/:id  – Get single event
// ─────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const event = await events.findById(req.params.id);

    if (!event) {
      return res
        .status(404)
        .json({ success: false, message: "Event not found." });
    }

    return res.status(200).json({
      success: true,
      event: formatEvent(event),
    });
  } catch (error) {
    console.error("Get event error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error." });
  }
});

// ─────────────────────────────────────────────
//  POST /events  – Create event (organizer only)
// ─────────────────────────────────────────────
router.post("/", authenticate, requireOrganizer, async (req, res) => {
  try {
    const { title, description, startsAt: rawStartsAt } = req.body;

    // Removed: console.log of req.user and req.body.
    //
    // Why this mattered more than it looks. Those two lines wrote the caller's
    // name and email address, plus the entire request body, to stdout on every
    // event creation. In any real deployment stdout is collected by a log
    // aggregator, retained for months, indexed, and readable by anyone with
    // dashboard access — so a debug line becomes long-lived storage of personal
    // data in a system that was never designed to hold it, outside whatever
    // deletion guarantees the app itself makes. Under GDPR that is processing
    // personal data with no lawful basis and no retention policy.
    //
    // The habit to build: debug logs are for the ten minutes you are debugging.
    // If a log line is worth keeping, it gets IDs, not payloads — `userId` and
    // `eventId` let you reconstruct what happened from the database, without the
    // log itself becoming a copy of the data.
    if (!title || !description || !rawStartsAt) {
      return res.status(400).json({
        success: false,
        message: "Title, description, and startsAt are required.",
      });
    }

    const checked = checkStartsAt(rawStartsAt);
    if (checked.error) {
      return res.status(400).json({ success: false, message: checked.error });
    }

    const newEvent = await events.create({
      title: title.trim(),
      description: description.trim(),
      startsAt: checked.startsAt,
      organizerId: req.user.id,
      organizerName: req.user.name,
    });

    return res.status(201).json({
      success: true,
      message: "Event created successfully.",
      event: formatEvent(newEvent),
    });
  } catch (error) {
    console.error("Create event error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error." });
  }
});

// ─────────────────────────────────────────────
//  PUT /events/:id  – Update event (organizer only)
// ─────────────────────────────────────────────
router.put("/:id", authenticate, requireOrganizer, async (req, res) => {
  try {
    const event = await events.findById(req.params.id);

    if (!event) {
      return res
        .status(404)
        .json({ success: false, message: "Event not found." });
    }

    if (event.organizerId !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: "Access denied. You can only update your own events.",
      });
    }

    const { title, description, startsAt: rawStartsAt } = req.body;

    // Present-but-invalid is a 400, same as on create. Absent or empty keeps the
    // current value, as it did before.
    let startsAt;
    if (rawStartsAt) {
      const checked = checkStartsAt(rawStartsAt);
      if (checked.error) {
        return res.status(400).json({ success: false, message: checked.error });
      }
      startsAt = checked.startsAt;
    }

    // Only the fields that were sent. An empty value keeps the current one, as
    // it did before. The repository `$set`s just these, so this cannot overwrite
    // a registration that arrived after the read above.
    const updatedEvent = await events.update(event.id, {
      title: title ? title.trim() : undefined,
      description: description ? description.trim() : undefined,
      startsAt,
    });

    // The event was deleted between the read and the write.
    if (!updatedEvent) {
      return res
        .status(404)
        .json({ success: false, message: "Event not found." });
    }

    // The participant list comes from the post-update document, so whoever was
    // registered when the write landed is who gets notified.
    if (updatedEvent.participants.length > 0) {
      sendEventUpdateEmail(updatedEvent.participants, updatedEvent).catch(
        (err) => console.error("Update notification error:", err.message),
      );
    }

    return res.status(200).json({
      success: true,
      message: "Event updated successfully.",
      event: formatEvent(updatedEvent),
    });
  } catch (error) {
    console.error("Update event error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error." });
  }
});

// ─────────────────────────────────────────────
//  DELETE /events/:id  – Delete event (organizer only)
// ─────────────────────────────────────────────
router.delete("/:id", authenticate, requireOrganizer, async (req, res) => {
  try {
    const event = await events.findById(req.params.id);

    if (!event) {
      return res
        .status(404)
        .json({ success: false, message: "Event not found." });
    }

    if (event.organizerId !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: "Access denied. You can only delete your own events.",
      });
    }

    // Registrations live inside the event, so deleting the event deletes them.
    // There is no second copy on the users to sweep — see POST /:id/register.
    await events.remove(event.id);

    return res.status(200).json({
      success: true,
      message: "Event deleted successfully.",
    });
  } catch (error) {
    console.error("Delete event error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error." });
  }
});

// ─────────────────────────────────────────────
//  POST /events/:id/register  – Register for event
// ─────────────────────────────────────────────
router.post("/:id/register", authenticate, async (req, res) => {
  try {
    const event = await events.findById(req.params.id);

    if (!event) {
      return res
        .status(404)
        .json({ success: false, message: "Event not found." });
    }

    if (req.user.role === "organizer") {
      return res.status(403).json({
        success: false,
        message: "Organizers cannot register as attendees for events.",
      });
    }

    if (event.startsAt < new Date()) {
      return res.status(400).json({
        success: false,
        message: "Cannot register for a past event.",
      });
    }

    // `event.participants` is the ONLY record of who is registered for what.
    //
    // This used to be a dual write: the participant was pushed here AND the
    // event id was pushed onto `user.registeredEvents`. Two sources of truth
    // for one fact, with nothing keeping them consistent — a failure between
    // the two writes (or the silent `userIndex === -1` skip) left them
    // disagreeing permanently, and unregister and delete-event each had to
    // remember to repair both. The mirror was also never read by anything.
    //
    // "What is this user registered for?" is now a query over events, backed
    // by the index on `events.participants.userUuid` — derived, not stored,
    // so it cannot drift.
    //
    // There is no "already registered?" check here. That check used to read the
    // array, test it, then push, and two concurrent requests could both pass it.
    // The repository does the check and the push as one atomic update, and
    // reports a duplicate as AlreadyRegisteredError.
    let registered;
    try {
      registered = await events.addParticipant(event.id, {
        userId: req.user.id,
        name: req.user.name,
        email: req.user.email,
      });
    } catch (err) {
      if (err instanceof events.AlreadyRegisteredError) {
        return res.status(409).json({ success: false, message: err.message });
      }
      throw err;
    }

    // The event was deleted between the read above and the update.
    if (!registered) {
      return res
        .status(404)
        .json({ success: false, message: "Event not found." });
    }

    const participant = registered.participants.find(
      (p) => p.userId === req.user.id,
    );

    // `req.user` was read from the users collection by `authenticate`, so it is
    // the system of record's view of the recipient, not a token's copy. Not
    // awaited: a slow SMTP server must not delay the response, and the `.catch()`
    // is what stops a failed send becoming an unhandledRejection (invariant 7).
    sendEventRegistrationEmail(req.user, registered).catch((err) =>
      console.error("Confirmation email error:", err.message),
    );

    return res.status(200).json({
      success: true,
      message: `Successfully registered for "${registered.title}".`,
      registration: {
        eventId: registered.id,
        eventTitle: registered.title,
        eventStartsAt: registered.startsAt,
        registeredAt: participant.registeredAt,
      },
    });
  } catch (error) {
    console.error("Event registration error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error." });
  }
});

// ─────────────────────────────────────────────
//  DELETE /events/:id/register  – Unregister from event
// ─────────────────────────────────────────────
router.delete("/:id/register", authenticate, async (req, res) => {
  try {
    // Read only to tell "no such event" apart from "not registered". Both are
    // 404s, but with different messages. The removal itself is one atomic `$pull`.
    const event = await events.findById(req.params.id);

    if (!event) {
      return res
        .status(404)
        .json({ success: false, message: "Event not found." });
    }

    const removed = await events.removeParticipant(event.id, req.user.id);

    if (!removed) {
      return res.status(404).json({
        success: false,
        message: "You are not registered for this event.",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Successfully unregistered from the event.",
    });
  } catch (error) {
    console.error("Unregister error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error." });
  }
});

// ─────────────────────────────────────────────
//  GET /events/:id/participants  – View participants (organizer only)
// ─────────────────────────────────────────────
router.get(
  "/:id/participants",
  authenticate,
  requireOrganizer,
  async (req, res) => {
    try {
      // Removed four console.log lines that dumped req.user, req.params, the store
      // size, and the whole event object — the last of which contains the full
      // participants array: every attendee's name and email, printed on every call
      // to this endpoint. This was the worst of the debug logging in the repo,
      // because it scaled with the number of registered attendees.
      const event = await events.findById(req.params.id);

      if (!event) {
        return res
          .status(404)
          .json({ success: false, message: "Event not found." });
      }

      if (event.organizerId !== req.user.id) {
        return res.status(403).json({
          success: false,
          message:
            "Access denied. You can only view participants for your own events.",
        });
      }

      return res.status(200).json({
        success: true,
        eventTitle: event.title,
        participantCount: event.participants.length,
        participants: event.participants,
      });
    } catch (error) {
      console.error("Get participants error:", error);
      return res
        .status(500)
        .json({ success: false, message: "Internal server error." });
    }
  },
);

module.exports = router;
