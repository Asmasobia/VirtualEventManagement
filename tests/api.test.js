const request = require("supertest");
const app = require("../app");
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
    // ✅ register and use token in SAME test — store not wiped between
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

  test("should fail if attendee registers twice", async () => {
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
      .post(`/events/${eventId}/register`)
      .set("Authorization", `Bearer ${attendeeToken}`);

    expect(res.statusCode).toBe(409);
    expect(res.body.success).toBe(false);
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
