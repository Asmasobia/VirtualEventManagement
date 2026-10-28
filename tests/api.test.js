const request = require("supertest");
const jwt = require("jsonwebtoken");
const app = require("../app");
const config = require("../config/env");
const db = require("../db/client");
const users = require("../repositories/usersRepository");
const { useTestDatabase } = require("./helpers/db");

// ─────────────────────────────────────────────
//  Mock email service — prevents SMTP errors
//  and speeds up tests significantly
// ─────────────────────────────────────────────
jest.mock("../services/emailService", () => ({
  sendWelcomeEmail: jest.fn().mockResolvedValue(undefined),
  sendEventRegistrationEmail: jest.fn().mockResolvedValue(undefined),
  sendEventUpdateEmail: jest.fn().mockResolvedValue(undefined),
}));
const { sendEventRegistrationEmail } = require("../services/emailService");

// ─────────────────────────────────────────────
//  Increase timeout for async tests
// ─────────────────────────────────────────────
jest.setTimeout(10000);

// ─────────────────────────────────────────────
//  Fresh state before each test
// ─────────────────────────────────────────────
// Users and events both live in the real test database, which the harness
// drops before each test.
useTestDatabase();

// ─────────────────────────────────────────────
//  Shared mock data
// ─────────────────────────────────────────────
const attendee = {
  name: "John Doe",
  email: "john@example.com",
  password: "password123",
  role: "attendee",
};

const organizer = {
  name: "Jane Smith",
  email: "jane@example.com",
  password: "password123",
  role: "organizer",
};

const eventData = {
  title: "Tech Conference 2025",
  description: "A virtual tech conference.",
  startsAt: "2099-12-01T10:00:00Z",
  capacity: 50,
};

// ─────────────────────────────────────────────
//  Helper: register and return token
// ─────────────────────────────────────────────
const registerAndLogin = async (userData) => {
  const res = await request(app).post("/register").send(userData);

  if (!res.body.token) {
    console.error("registerAndLogin failed:", JSON.stringify(res.body));
  }

  return res.body.token;
};

// ─────────────────────────────────────────────
//  POST /register
// ─────────────────────────────────────────────
describe("POST /register", () => {
  test("should register a new attendee successfully", async () => {
    const res = await request(app).post("/register").send(attendee);

    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.token).toBeDefined();
    expect(res.body.user.email).toBe(attendee.email);
    expect(res.body.user.password).toBeUndefined();
  });

  test("should register a new organizer successfully", async () => {
    const res = await request(app).post("/register").send(organizer);

    expect(res.statusCode).toBe(201);
    expect(res.body.user.role).toBe("organizer");
  });

  test("should fail if required fields are missing", async () => {
    const res = await request(app)
      .post("/register")
      .send({ email: "test@example.com" });

    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("should fail with invalid email format", async () => {
    const res = await request(app)
      .post("/register")
      .send({ ...attendee, email: "invalid-email" });

    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("should fail with short password", async () => {
    const res = await request(app)
      .post("/register")
      .send({ ...attendee, password: "123" });

    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("should fail if email already exists", async () => {
    await request(app).post("/register").send(attendee);

    const res = await request(app).post("/register").send(attendee);

    expect(res.statusCode).toBe(409);
    expect(res.body.success).toBe(false);
  });

  test("should fail with invalid role", async () => {
    const res = await request(app)
      .post("/register")
      .send({ ...attendee, role: "admin" });

    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

// ─────────────────────────────────────────────
//  POST /login
// ─────────────────────────────────────────────
describe("POST /login", () => {
  beforeEach(async () => {
    await request(app).post("/register").send(attendee);
  });

  test("should login successfully with correct credentials", async () => {
    const res = await request(app)
      .post("/login")
      .send({ email: attendee.email, password: attendee.password });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.token).toBeDefined();
  });

  test("should fail with wrong password", async () => {
    const res = await request(app)
      .post("/login")
      .send({ email: attendee.email, password: "wrongpassword" });

    expect(res.statusCode).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test("should fail with unregistered email", async () => {
    const res = await request(app)
      .post("/login")
      .send({ email: "nouser@example.com", password: "password123" });

    expect(res.statusCode).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test("should fail if fields are missing", async () => {
    const res = await request(app)
      .post("/login")
      .send({ email: attendee.email });

    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

// ─────────────────────────────────────────────
//  GET /profile
// ─────────────────────────────────────────────
describe("GET /profile", () => {
  test("should return profile for authenticated user", async () => {
    const token = await registerAndLogin(attendee);

    const res = await request(app)
      .get("/profile")
      .set("Authorization", `Bearer ${token}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.user.email).toBe(attendee.email);
    expect(res.body.user.password).toBeUndefined();
  });

  test("should fail without token", async () => {
    const res = await request(app).get("/profile");

    expect(res.statusCode).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test("should fail with invalid token", async () => {
    const res = await request(app)
      .get("/profile")
      .set("Authorization", "Bearer invalidtoken");

    expect(res.statusCode).toBe(401);
    expect(res.body.success).toBe(false);
  });
});

// ─────────────────────────────────────────────
//  Authentication reads the system of record
// ─────────────────────────────────────────────
// Each test here is a case the old payload-trusting middleware got wrong: the
// token is still correctly signed and unexpired, but what it claims is no longer
// true. Accounts are deleted and demoted directly in the database because the API
// has no endpoint for either yet. What is under test is how authentication reacts
// when the record changes underneath a live token, not how the record changes.
describe("authentication against the users collection", () => {
  const usersCollection = () => db.getDb().collection("users");
  const profileWith = (token) =>
    request(app).get("/profile").set("Authorization", `Bearer ${token}`);

  test("rejects the token of a user who has since been deleted", async () => {
    const token = await registerAndLogin(attendee);
    await usersCollection().deleteOne({ email: attendee.email });

    const res = await profileWith(token);

    expect(res.statusCode).toBe(401);
    expect(res.body.message).toBe("Invalid token.");
  });

  test("applies a demotion on the next request, not at token expiry", async () => {
    const token = await registerAndLogin(organizer);
    await usersCollection().updateOne(
      { email: organizer.email },
      { $set: { role: "attendee" } },
    );

    const res = await request(app)
      .post("/events")
      .set("Authorization", `Bearer ${token}`)
      .send(eventData);

    expect(res.statusCode).toBe(403);
  });

  test("serves the current record, not the one at signing", async () => {
    const token = await registerAndLogin(attendee);
    await usersCollection().updateOne(
      { email: attendee.email },
      { $set: { name: "John Renamed" } },
    );

    const res = await profileWith(token);

    expect(res.statusCode).toBe(200);
    expect(res.body.user.name).toBe("John Renamed");
  });

  test("rejects a correctly signed token that carries no version", async () => {
    // The pre-revocation payload shape. A token with no version can never be
    // revoked, so it must not be accepted as version 0 by default.
    const user = await users.create({
      name: "Legacy",
      email: "legacy@example.com",
      passwordHash: "not-a-real-hash",
      role: "attendee",
    });
    const legacy = jwt.sign(
      { id: user.id, sub: user.id, role: "attendee" },
      config.jwt.secret,
    );

    const res = await profileWith(legacy);

    expect(res.statusCode).toBe(401);
  });

  test("answers 500, not 401, when the user lookup itself fails", async () => {
    // A 401 during a database outage would tell every client its token is bad,
    // and a well-behaved client responds by discarding it and logging out.
    const token = await registerAndLogin(attendee);
    const lookup = jest
      .spyOn(users, "findSession")
      .mockRejectedValueOnce(new Error("connection lost"));
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});

    try {
      const res = await profileWith(token);
      expect(res.statusCode).toBe(500);
    } finally {
      lookup.mockRestore();
      consoleError.mockRestore();
    }
  });
});

// ─────────────────────────────────────────────
//  POST /logout-all
// ─────────────────────────────────────────────
describe("POST /logout-all", () => {
  const loginAs = async (user) =>
    (
      await request(app)
        .post("/login")
        .send({ email: user.email, password: user.password })
    ).body.token;

  test("revokes every token the user holds, on every device", async () => {
    const laptop = await registerAndLogin(attendee);
    const phone = await loginAs(attendee);

    const res = await request(app)
      .post("/logout-all")
      .set("Authorization", `Bearer ${phone}`);
    expect(res.statusCode).toBe(200);

    for (const token of [laptop, phone]) {
      const after = await request(app)
        .get("/profile")
        .set("Authorization", `Bearer ${token}`);
      expect(after.statusCode).toBe(401);
      // Same message as a deleted account: a revoked token must not reveal that
      // its account still exists.
      expect(after.body.message).toBe("Invalid token.");
    }
  });

  test("leaves a login made afterwards working", async () => {
    const before = await registerAndLogin(attendee);
    await request(app)
      .post("/logout-all")
      .set("Authorization", `Bearer ${before}`);

    const fresh = await loginAs(attendee);
    const res = await request(app)
      .get("/profile")
      .set("Authorization", `Bearer ${fresh}`);

    expect(res.statusCode).toBe(200);
  });

  test("does not touch another user's sessions", async () => {
    const mine = await registerAndLogin(attendee);
    const theirs = await registerAndLogin(organizer);

    await request(app)
      .post("/logout-all")
      .set("Authorization", `Bearer ${mine}`);

    const res = await request(app)
      .get("/profile")
      .set("Authorization", `Bearer ${theirs}`);
    expect(res.statusCode).toBe(200);
  });

  test("should fail without authentication", async () => {
    const res = await request(app).post("/logout-all");

    expect(res.statusCode).toBe(401);
  });
});

// ─────────────────────────────────────────────
//  POST /events
// ─────────────────────────────────────────────
describe("POST /events", () => {
  test("should create event as organizer", async () => {
    const token = await registerAndLogin(organizer);

    const res = await request(app)
      .post("/events")
      .set("Authorization", `Bearer ${token}`)
      .send(eventData);

    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.event.title).toBe(eventData.title);
    expect(res.body.event.organizerName).toBe(organizer.name);
    // One UTC instant, serialised as ISO-8601. The old date/time pair is gone.
    expect(res.body.event.startsAt).toBe("2099-12-01T10:00:00.000Z");
    expect(res.body.event.capacity).toBe(50);
    expect(res.body.event).not.toHaveProperty("date");
    expect(res.body.event).not.toHaveProperty("time");
  });

  test("should normalise an offset start to the same UTC instant", async () => {
    const token = await registerAndLogin(organizer);

    const res = await request(app)
      .post("/events")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...eventData, startsAt: "2099-12-01T15:30:00+05:30" });

    expect(res.statusCode).toBe(201);
    expect(res.body.event.startsAt).toBe("2099-12-01T10:00:00.000Z");
  });

  test("should fail if attendee tries to create event", async () => {
    const token = await registerAndLogin(attendee);

    const res = await request(app)
      .post("/events")
      .set("Authorization", `Bearer ${token}`)
      .send(eventData);

    expect(res.statusCode).toBe(403);
    expect(res.body.success).toBe(false);
  });

  test("should fail without authentication", async () => {
    const res = await request(app).post("/events").send(eventData);

    expect(res.statusCode).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test("should fail with missing required fields", async () => {
    const token = await registerAndLogin(organizer);

    const res = await request(app)
      .post("/events")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Incomplete Event" });

    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("should fail with a past start", async () => {
    const token = await registerAndLogin(organizer);

    const res = await request(app)
      .post("/events")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...eventData, startsAt: "2020-01-01T10:00:00Z" });

    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
  });

  // Each of these is accepted by `new Date(string)`. The 400 is the point.
  test.each([
    ["no UTC offset", "2099-12-01T10:00:00"],
    ["a date with no time", "2099-12-01"],
    ["a day that does not exist", "2099-02-30T10:00:00Z"],
    ["a non-string", 4102480800000],
  ])("should fail with %s", async (_label, startsAt) => {
    const token = await registerAndLogin(organizer);

    const res = await request(app)
      .post("/events")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...eventData, startsAt });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/startsAt/);
  });

  // Capacity is required, not defaulted. An event with no limit would make the
  // embedded participant list unbounded, which is the one thing the embedded
  // design cannot afford.
  test("should fail without a capacity", async () => {
    const token = await registerAndLogin(organizer);
    const { capacity: _omitted, ...withoutCapacity } = eventData;

    const res = await request(app)
      .post("/events")
      .set("Authorization", `Bearer ${token}`)
      .send(withoutCapacity);

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/capacity/);
  });

  test.each([
    ["zero", 0],
    ["a negative number", -5],
    ["a fraction", 2.5],
    ["a numeric string", "50"],
    ["more than the maximum", 10_001],
    ["null", null],
  ])("should fail with a capacity of %s", async (_label, capacity) => {
    const token = await registerAndLogin(organizer);

    const res = await request(app)
      .post("/events")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...eventData, capacity });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/capacity/);
  });

  test("should ignore capacity on update", async () => {
    const token = await registerAndLogin(organizer);

    const created = await request(app)
      .post("/events")
      .set("Authorization", `Bearer ${token}`)
      .send(eventData);

    const res = await request(app)
      .put(`/events/${created.body.event.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ capacity: 1 });

    expect(res.statusCode).toBe(200);
    expect(res.body.event.capacity).toBe(eventData.capacity);
  });

  test("should reject the old date and time fields", async () => {
    const token = await registerAndLogin(organizer);
    const { startsAt: _omitted, ...rest } = eventData;

    const res = await request(app)
      .post("/events")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...rest, date: "2099-12-01", time: "10:00 AM" });

    expect(res.statusCode).toBe(400);
  });
});

// ─────────────────────────────────────────────
//  GET /events
// ─────────────────────────────────────────────
describe("GET /events", () => {
  test("should return empty list when no events exist", async () => {
    const res = await request(app).get("/events");

    expect(res.statusCode).toBe(200);
    expect(res.body.events).toHaveLength(0);
  });

  test("should return all events", async () => {
    const token = await registerAndLogin(organizer);

    await request(app)
      .post("/events")
      .set("Authorization", `Bearer ${token}`)
      .send(eventData);

    const res = await request(app).get("/events");

    expect(res.statusCode).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.count).toBe(1);
  });

  test("should filter upcoming events", async () => {
    const token = await registerAndLogin(organizer);

    await request(app)
      .post("/events")
      .set("Authorization", `Bearer ${token}`)
      .send(eventData);

    const res = await request(app).get("/events?upcoming=true");

    expect(res.statusCode).toBe(200);
    expect(res.body.events).toHaveLength(1);
  });

  test("should filter events by search keyword", async () => {
    const token = await registerAndLogin(organizer);

    await request(app)
      .post("/events")
      .set("Authorization", `Bearer ${token}`)
      .send(eventData);

    const res = await request(app).get("/events?search=Tech");

    expect(res.statusCode).toBe(200);
    expect(res.body.events).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────
//  GET /events/:id
// ─────────────────────────────────────────────
describe("GET /events/:id", () => {
  test("should return a single event by ID", async () => {
    const token = await registerAndLogin(organizer);

    const created = await request(app)
      .post("/events")
      .set("Authorization", `Bearer ${token}`)
      .send(eventData);

    const eventId = created.body.event.id;

    const res = await request(app).get(`/events/${eventId}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.event.id).toBe(eventId);
  });

  test("should return 404 for non-existent event", async () => {
    const res = await request(app).get("/events/nonexistentid");

    expect(res.statusCode).toBe(404);
    expect(res.body.success).toBe(false);
  });
});

// ─────────────────────────────────────────────
//  PUT /events/:id
// ─────────────────────────────────────────────
describe("PUT /events/:id", () => {
  test("should update event as owner organizer", async () => {
    const token = await registerAndLogin(organizer);

    const created = await request(app)
      .post("/events")
      .set("Authorization", `Bearer ${token}`)
      .send(eventData);

    const eventId = created.body.event.id;

    const res = await request(app)
      .put(`/events/${eventId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Updated Conference" });

    expect(res.statusCode).toBe(200);
    expect(res.body.event.title).toBe("Updated Conference");
  });

  test("should fail if another organizer tries to update", async () => {
    const token1 = await registerAndLogin(organizer);
    const token2 = await registerAndLogin({
      ...organizer,
      email: "other.organizer@example.com",
    });

    const created = await request(app)
      .post("/events")
      .set("Authorization", `Bearer ${token1}`)
      .send(eventData);

    const eventId = created.body.event.id;

    const res = await request(app)
      .put(`/events/${eventId}`)
      .set("Authorization", `Bearer ${token2}`)
      .send({ title: "Hacked Title" });

    expect(res.statusCode).toBe(403);
    expect(res.body.success).toBe(false);
  });

  test("should fail with a past start on update", async () => {
    const token = await registerAndLogin(organizer);

    const created = await request(app)
      .post("/events")
      .set("Authorization", `Bearer ${token}`)
      .send(eventData);

    const eventId = created.body.event.id;

    const res = await request(app)
      .put(`/events/${eventId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ startsAt: "2020-01-01T10:00:00Z" });

    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("should reject a malformed start on update, and change nothing", async () => {
    const token = await registerAndLogin(organizer);

    const created = await request(app)
      .post("/events")
      .set("Authorization", `Bearer ${token}`)
      .send(eventData);

    const eventId = created.body.event.id;

    const res = await request(app)
      .put(`/events/${eventId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ startsAt: "2099-12-01T10:00:00" });

    expect(res.statusCode).toBe(400);

    const after = await request(app).get(`/events/${eventId}`);
    expect(after.body.event.startsAt).toBe("2099-12-01T10:00:00.000Z");
  });

  test("should update the start", async () => {
    const token = await registerAndLogin(organizer);

    const created = await request(app)
      .post("/events")
      .set("Authorization", `Bearer ${token}`)
      .send(eventData);

    const res = await request(app)
      .put(`/events/${created.body.event.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ startsAt: "2099-12-02T09:00:00Z" });

    expect(res.statusCode).toBe(200);
    expect(res.body.event.startsAt).toBe("2099-12-02T09:00:00.000Z");
  });
});

// ─────────────────────────────────────────────
//  DELETE /events/:id
// ─────────────────────────────────────────────
describe("DELETE /events/:id", () => {
  test("should delete event as owner organizer", async () => {
    const token = await registerAndLogin(organizer);

    const created = await request(app)
      .post("/events")
      .set("Authorization", `Bearer ${token}`)
      .send(eventData);

    const eventId = created.body.event.id;

    const res = await request(app)
      .delete(`/events/${eventId}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test("should return 404 after deletion", async () => {
    const token = await registerAndLogin(organizer);

    const created = await request(app)
      .post("/events")
      .set("Authorization", `Bearer ${token}`)
      .send(eventData);

    const eventId = created.body.event.id;

    await request(app)
      .delete(`/events/${eventId}`)
      .set("Authorization", `Bearer ${token}`);

    const res = await request(app).get(`/events/${eventId}`);
    expect(res.statusCode).toBe(404);
  });

  test("should fail if attendee tries to delete event", async () => {
    const organizerToken = await registerAndLogin(organizer);
    const attendeeToken = await registerAndLogin(attendee);

    const created = await request(app)
      .post("/events")
      .set("Authorization", `Bearer ${organizerToken}`)
      .send(eventData);

    const eventId = created.body.event.id;

    const res = await request(app)
      .delete(`/events/${eventId}`)
      .set("Authorization", `Bearer ${attendeeToken}`);

    expect(res.statusCode).toBe(403);
    expect(res.body.success).toBe(false);
  });
});

// ─────────────────────────────────────────────
//  POST /events/:id/register
// ─────────────────────────────────────────────
describe("POST /events/:id/register", () => {
  test("should register attendee for an event", async () => {
    const organizerToken = await registerAndLogin(organizer);
    const attendeeToken = await registerAndLogin(attendee);

    const created = await request(app)
      .post("/events")
      .set("Authorization", `Bearer ${organizerToken}`)
      .send(eventData);

    const eventId = created.body.event.id;

    const res = await request(app)
      .post(`/events/${eventId}/register`)
      .set("Authorization", `Bearer ${attendeeToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.registration.eventId).toBe(eventId);
  });

  // Idempotent: the second request is what a client sends when the response to
  // the first was lost. It must get the same answer, not a 409 for something
  // that worked, and the attendee must not get a second confirmation email.
  test("should return the existing registration if attendee registers twice", async () => {
    const organizerToken = await registerAndLogin(organizer);
    const attendeeToken = await registerAndLogin(attendee);

    const created = await request(app)
      .post("/events")
      .set("Authorization", `Bearer ${organizerToken}`)
      .send(eventData);

    const eventId = created.body.event.id;
    sendEventRegistrationEmail.mockClear();

    const first = await request(app)
      .post(`/events/${eventId}/register`)
      .set("Authorization", `Bearer ${attendeeToken}`);

    const res = await request(app)
      .post(`/events/${eventId}/register`)
      .set("Authorization", `Bearer ${attendeeToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(first.body);
    expect(sendEventRegistrationEmail).toHaveBeenCalledTimes(1);

    const after = await request(app).get(`/events/${eventId}`);
    expect(after.body.event.participantCount).toBe(1);
  });

  test("should fail with 409 when the event is full", async () => {
    const organizerToken = await registerAndLogin(organizer);
    const firstToken = await registerAndLogin(attendee);
    const secondToken = await registerAndLogin({
      ...attendee,
      email: "second@example.com",
    });

    const created = await request(app)
      .post("/events")
      .set("Authorization", `Bearer ${organizerToken}`)
      .send({ ...eventData, capacity: 1 });

    const eventId = created.body.event.id;

    await request(app)
      .post(`/events/${eventId}/register`)
      .set("Authorization", `Bearer ${firstToken}`);

    const res = await request(app)
      .post(`/events/${eventId}/register`)
      .set("Authorization", `Bearer ${secondToken}`);

    expect(res.statusCode).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/full/);
  });

  test("should fail if organizer tries to register for event", async () => {
    const organizerToken = await registerAndLogin(organizer);

    const created = await request(app)
      .post("/events")
      .set("Authorization", `Bearer ${organizerToken}`)
      .send(eventData);

    const eventId = created.body.event.id;

    const res = await request(app)
      .post(`/events/${eventId}/register`)
      .set("Authorization", `Bearer ${organizerToken}`);

    expect(res.statusCode).toBe(403);
    expect(res.body.success).toBe(false);
  });

  test("should fail without authentication", async () => {
    const organizerToken = await registerAndLogin(organizer);

    const created = await request(app)
      .post("/events")
      .set("Authorization", `Bearer ${organizerToken}`)
      .send(eventData);

    const eventId = created.body.event.id;

    const res = await request(app).post(`/events/${eventId}/register`);

    expect(res.statusCode).toBe(401);
    expect(res.body.success).toBe(false);
  });

  // The PR 3 acceptance test, end to end: concurrent requests through the real
  // middleware and the real database, at an event with capacity N. Exactly N
  // must succeed. The repository test proves the same thing about the update
  // itself. This one proves no layer above it reintroduces a read-then-write,
  // for example a route that checks the participant count before calling the
  // repository.
  //
  // Each attendee is a real user, because authenticate looks every token's user
  // up (invariant 8). They are seeded through the repository rather than
  // POST /register, because twenty bcrypt hashes would take most of the test's
  // time limit and are not what is under test.
  test("should never overbook under concurrent registrations", async () => {
    const capacity = 5;
    const organizerToken = await registerAndLogin(organizer);

    const created = await request(app)
      .post("/events")
      .set("Authorization", `Bearer ${organizerToken}`)
      .send({ ...eventData, capacity });

    const eventId = created.body.event.id;

    const tokens = await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        const user = await users.create({
          name: `Attendee ${i}`,
          email: `attendee${i}@example.com`,
          passwordHash: "not-a-real-hash",
          role: "attendee",
        });
        return jwt.sign(
          { sub: user.id, ver: users.INITIAL_TOKEN_VERSION },
          config.jwt.secret,
        );
      }),
    );

    const responses = await Promise.all(
      tokens.map((token) =>
        request(app)
          .post(`/events/${eventId}/register`)
          .set("Authorization", `Bearer ${token}`),
      ),
    );

    const statuses = responses.map((r) => r.statusCode);
    expect(statuses.filter((s) => s === 200)).toHaveLength(capacity);
    expect(statuses.filter((s) => s === 409)).toHaveLength(
      tokens.length - capacity,
    );

    const after = await request(app).get(`/events/${eventId}`);
    expect(after.body.event.participantCount).toBe(capacity);
  });
});

// ─────────────────────────────────────────────
//  DELETE /events/:id/register
// ─────────────────────────────────────────────
describe("DELETE /events/:id/register", () => {
  test("should unregister attendee from event", async () => {
    const organizerToken = await registerAndLogin(organizer);
    const attendeeToken = await registerAndLogin(attendee);

    const created = await request(app)
      .post("/events")
      .set("Authorization", `Bearer ${organizerToken}`)
      .send(eventData);

    const eventId = created.body.event.id;

    await request(app)
      .post(`/events/${eventId}/register`)
      .set("Authorization", `Bearer ${attendeeToken}`);

    const res = await request(app)
      .delete(`/events/${eventId}/register`)
      .set("Authorization", `Bearer ${attendeeToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test("should fail if attendee is not registered", async () => {
    const organizerToken = await registerAndLogin(organizer);
    const attendeeToken = await registerAndLogin(attendee);

    const created = await request(app)
      .post("/events")
      .set("Authorization", `Bearer ${organizerToken}`)
      .send(eventData);

    const eventId = created.body.event.id;

    const res = await request(app)
      .delete(`/events/${eventId}/register`)
      .set("Authorization", `Bearer ${attendeeToken}`);

    expect(res.statusCode).toBe(404);
    expect(res.body.success).toBe(false);
  });
});

// ─────────────────────────────────────────────
//  GET /events/:id/participants
// ─────────────────────────────────────────────
describe("GET /events/:id/participants", () => {
  test("should return participants list for event owner", async () => {
    const organizerToken = await registerAndLogin(organizer);
    const attendeeToken = await registerAndLogin(attendee);

    const created = await request(app)
      .post("/events")
      .set("Authorization", `Bearer ${organizerToken}`)
      .send(eventData);

    const eventId = created.body.event.id;

    await request(app)
      .post(`/events/${eventId}/register`)
      .set("Authorization", `Bearer ${attendeeToken}`);

    const res = await request(app)
      .get(`/events/${eventId}/participants`)
      .set("Authorization", `Bearer ${organizerToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.participants).toHaveLength(1);
    expect(res.body.participants[0].email).toBe(attendee.email);
  });

  test("should fail if attendee tries to view participants", async () => {
    const organizerToken = await registerAndLogin(organizer);
    const attendeeToken = await registerAndLogin(attendee);

    const created = await request(app)
      .post("/events")
      .set("Authorization", `Bearer ${organizerToken}`)
      .send(eventData);

    const eventId = created.body.event.id;

    const res = await request(app)
      .get(`/events/${eventId}/participants`)
      .set("Authorization", `Bearer ${attendeeToken}`);

    expect(res.statusCode).toBe(403);
    expect(res.body.success).toBe(false);
  });
});
