const request = require("supertest");
const app = require("../app");
const db = require("../db/client");

// Runs against the real MongoDB (the dedicated test database from config/env.js),
// not a mocked driver. Start mongod by hand first — see MONGODB.local.md.

afterAll(async () => {
  await db.close();
});

describe("GET /ready", () => {
  it("answers 503 while the database is not connected", async () => {
    await db.close();
    const res = await request(app).get("/ready");
    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
  });

  it("answers 200 once the database is connected", async () => {
    await db.connect();
    const res = await request(app).get("/ready");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("goes back to 503 when the connection is closed", async () => {
    await db.connect();
    await db.close();
    const res = await request(app).get("/ready");
    expect(res.status).toBe(503);
  });

  it("does not leak driver error text to the caller", async () => {
    await db.close();
    const res = await request(app).get("/ready");
    expect(JSON.stringify(res.body)).not.toMatch(/mongo|connect|27017/i);
  });
});

describe("GET /health", () => {
  it("stays 200 with no database connection (liveness is dependency-free)", async () => {
    await db.close();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
  });
});
