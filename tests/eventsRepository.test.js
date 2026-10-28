const db = require("../db/client");
const events = require("../repositories/eventsRepository");
const { useTestDatabase } = require("./helpers/db");

// What the routes rely on from this module: domain objects with public ids and
// no storage internals; filters that do what the API promised and nothing
// more; and registration rules enforced by the database rather than by a
// read-then-check in the caller. Each is checked here against the real
// database.

useTestDatabase();

const conference = {
  title: "Tech Conference",
  description: "A virtual tech conference.",
  startsAt: new Date("2099-12-01T10:00:00Z"),
  capacity: 10,
  organizerId: "organizer-1",
  organizerName: "Jane Smith",
};

const john = { userId: "user-1", name: "John Doe", email: "john@example.com" };
const jane = { userId: "user-2", name: "Jane Roe", email: "jane@example.com" };

describe("eventsRepository", () => {
  it("returns a domain object: public ids, no _id", async () => {
    const event = await events.create(conference);

    expect(event).toEqual({
      id: expect.any(String),
      title: conference.title,
      description: conference.description,
      startsAt: conference.startsAt,
      capacity: 10,
      organizerId: "organizer-1",
      organizerName: "Jane Smith",
      participants: [],
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
  });

  it("stores references as uuids under the indexed field names", async () => {
    const event = await events.create(conference);
    await events.addParticipant(event.id, john);

    const doc = await db
      .getDb()
      .collection("events")
      .findOne({ uuid: event.id });

    expect(doc.organizerUuid).toBe("organizer-1");
    expect(doc.participants[0].userUuid).toBe("user-1");
    expect(doc._id.toString()).not.toBe(event.id);
  });

  it("returns null for an unknown id", async () => {
    expect(await events.findById("no-such-id")).toBeNull();
    expect(await events.update("no-such-id", { title: "x" })).toBeNull();
    expect(await events.remove("no-such-id")).toBe(false);
  });

  describe("list", () => {
    it("filters by organizer and sorts soonest first", async () => {
      await events.create({
        ...conference,
        startsAt: new Date("2099-12-02T10:00:00Z"),
        title: "B",
      });
      await events.create({
        ...conference,
        startsAt: new Date("2099-12-01T10:00:00Z"),
        title: "A",
      });
      await events.create({ ...conference, organizerId: "someone-else" });

      const found = await events.list({ organizerId: "organizer-1" });
      expect(found.map((e) => e.title)).toEqual(["A", "B"]);
    });

    // The old string pair sorted by "10:00 AM" vs "9:00 AM" as text, putting
    // 10 before 9. Same day, so only the time of day decides the order.
    it("orders events on the same day by time of day, not by text", async () => {
      await events.create({
        ...conference,
        startsAt: new Date("2099-12-01T10:00:00Z"),
        title: "ten",
      });
      await events.create({
        ...conference,
        startsAt: new Date("2099-12-01T09:00:00Z"),
        title: "nine",
      });

      const found = await events.list();
      expect(found.map((e) => e.title)).toEqual(["nine", "ten"]);
    });

    it("excludes past events when upcoming is set", async () => {
      await events.create({
        ...conference,
        startsAt: new Date("2000-01-01T10:00:00Z"),
        title: "Old",
      });
      await events.create({ ...conference, title: "New" });

      const found = await events.list({ upcoming: true });
      expect(found.map((e) => e.title)).toEqual(["New"]);
    });

    it("searches title and description case-insensitively", async () => {
      await events.create({ ...conference, title: "Node Meetup" });
      await events.create({
        ...conference,
        title: "Other",
        description: "NODE",
      });
      await events.create({
        ...conference,
        title: "Unrelated",
        description: "-",
      });

      expect(await events.list({ search: "node" })).toHaveLength(2);
    });

    // Without escaping, "(" is a server-side regex syntax error (a 500) and "."
    // matches everything. Escaped, the input only ever matches itself.
    it("treats regex metacharacters in a search as literal text", async () => {
      // Descriptions without punctuation, so a literal "." has nothing to match.
      await events.create({
        ...conference,
        title: "C++ Workshop",
        description: "-",
      });
      await events.create({
        ...conference,
        title: "Rust Workshop",
        description: "-",
      });

      expect(await events.list({ search: "c++" })).toHaveLength(1);
      expect(await events.list({ search: "." })).toHaveLength(0);
      expect(await events.list({ search: "(" })).toHaveLength(0);
    });

    it("ignores a filter value that is not a string", async () => {
      await events.create(conference);

      // What a repeated query key (?organizerId=a&organizerId=b) arrives as.
      expect(await events.list({ organizerId: ["a", "b"] })).toHaveLength(1);
    });
  });

  it("updates only the fields given", async () => {
    const event = await events.create(conference);
    const updated = await events.update(event.id, {
      title: "Renamed",
      organizerId: "hijacked",
    });

    expect(updated.title).toBe("Renamed");
    expect(updated.description).toBe(conference.description);
    expect(updated.organizerId).toBe("organizer-1");
  });

  // The lost-update bug a whole-document write would have: a registration
  // made after the organizer's read must survive the organizer's write.
  it("does not wipe a registration that lands between read and update", async () => {
    const event = await events.create(conference);
    const staleRead = await events.findById(event.id);
    await events.addParticipant(event.id, john);

    const updated = await events.update(staleRead.id, { title: "Renamed" });
    expect(updated.participants).toHaveLength(1);
  });

  describe("registration", () => {
    it("adds a participant and returns the updated event", async () => {
      const event = await events.create(conference);
      const { event: registered, created } = await events.addParticipant(
        event.id,
        john,
      );

      expect(created).toBe(true);
      expect(registered.participants).toEqual([
        { ...john, registeredAt: expect.any(Date) },
      ]);
    });

    it("returns null when the event does not exist", async () => {
      expect(await events.addParticipant("no-such-id", john)).toBeNull();
    });

    // Idempotent: the retry of a request whose response was lost gets the
    // original registration back, and nothing is written a second time.
    it("treats a repeat registration as success, without adding anyone", async () => {
      const event = await events.create(conference);
      const first = await events.addParticipant(event.id, john);
      const again = await events.addParticipant(event.id, john);

      expect(again.created).toBe(false);
      expect(again.event.participants).toHaveLength(1);
      expect(again.event.participants[0].registeredAt).toEqual(
        first.event.participants[0].registeredAt,
      );
    });

    // The race the old read-check-push code had: every request saw "not
    // registered yet" and every one pushed. With the check inside the update's
    // filter, exactly one of a concurrent burst can write. The others are still
    // successes, because the user did end up registered.
    it("writes exactly once for several concurrent duplicate registrations", async () => {
      const event = await events.create(conference);

      const results = await Promise.all(
        Array.from({ length: 5 }, () => events.addParticipant(event.id, john)),
      );

      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect((await events.findById(event.id)).participants).toHaveLength(1);
    });

    it("rejects a new participant with EventFullError when there is no place", async () => {
      const event = await events.create({ ...conference, capacity: 1 });
      await events.addParticipant(event.id, john);

      await expect(
        events.addParticipant(event.id, jane),
      ).rejects.toBeInstanceOf(events.EventFullError);
      expect((await events.findById(event.id)).participants).toHaveLength(1);
    });

    // Order of the checks after a failed update: "already registered" must win
    // over "full", or the retry of the registration that took the last place
    // would be told the event is full.
    it("still treats a repeat as success once the event is full", async () => {
      const event = await events.create({ ...conference, capacity: 1 });
      await events.addParticipant(event.id, john);

      const again = await events.addParticipant(event.id, john);
      expect(again.created).toBe(false);
    });

    // The test this PR exists for. Twenty different users race for five places.
    // Read-check-write lets every request see a free place before any of them
    // pushes, so it would overbook. The conditional update must let in exactly
    // five, however the requests interleave.
    it("never overbooks under concurrent registrations by different users", async () => {
      const capacity = 5;
      const event = await events.create({ ...conference, capacity });
      const people = Array.from({ length: 20 }, (_, i) => ({
        userId: `user-${i}`,
        name: `User ${i}`,
        email: `user${i}@example.com`,
      }));

      const results = await Promise.allSettled(
        people.map((p) => events.addParticipant(event.id, p)),
      );

      const won = results.filter((r) => r.status === "fulfilled");
      const lost = results.filter((r) => r.status === "rejected");
      expect(won).toHaveLength(capacity);
      for (const r of won) expect(r.value.created).toBe(true);
      expect(lost).toHaveLength(people.length - capacity);
      for (const r of lost) {
        expect(r.reason).toBeInstanceOf(events.EventFullError);
      }
      expect((await events.findById(event.id)).participants).toHaveLength(
        capacity,
      );
    });

    // Fails closed: an event with no recorded limit takes nobody, rather than
    // everybody. Inserted directly, because create() can no longer make one.
    it("treats an event stored without a capacity as full", async () => {
      await db.getDb().collection("events").insertOne({
        uuid: "legacy-1",
        title: "Legacy",
        description: "-",
        startsAt: conference.startsAt,
        organizerUuid: "organizer-1",
        organizerName: "Jane Smith",
        participants: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await expect(
        events.addParticipant("legacy-1", john),
      ).rejects.toBeInstanceOf(events.EventFullError);
    });

    it("removes a participant, and reports when there was nothing to remove", async () => {
      const event = await events.create(conference);
      await events.addParticipant(event.id, john);

      expect(await events.removeParticipant(event.id, john.userId)).toBe(true);
      expect(await events.removeParticipant(event.id, john.userId)).toBe(false);
      expect((await events.findById(event.id)).participants).toEqual([]);
    });
  });
});
