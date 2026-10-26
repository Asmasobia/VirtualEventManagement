// ─────────────────────────────────────────────────────────────────────────────
//  BUILDS THE EXPRESS APP AND EXPORTS IT. DOES NOT LISTEN.
//
//  This file used to end with `app.listen(PORT)` and also `module.exports = app`,
//  and that combination is the bug worth understanding, because it is extremely
//  common and it hides behind a passing test suite.
//
//  `require()` executes a module's top level. So the moment `tests/api.test.js`
//  did `const app = require("../app")`, a real TCP listener opened on port 3000 —
//  as a side effect of an import. Consequences, all of which this repo actually
//  had:
//
//    • `jest --runInBand` was mandatory. Two test files in parallel would each
//      import the app, and the second would die with EADDRINUSE. The flag was
//      papering over a design problem: the suite could not be parallelised, so
//      it gets slower forever as tests are added.
//
//    • Running `npm test` while `npm run dev` was open would fail, for a reason
//      with nothing to do with the code under test.
//
//    • Supertest never needed the listener anyway. Handing `request()` an app
//      object makes it bind an ephemeral port itself, run the request, and close
//      it. The port-3000 listener sat there unused for the whole suite.
//
//  THE PATTERN: a module should define things; a module should not start things.
//  Keep the side effect (listening) in a separate entry point that nothing else
//  imports. Then the app is a value you can construct, inspect, and test — and
//  in future, construct twice with different config, which is what you need the
//  day you want an integration test against a throwaway database.
// ─────────────────────────────────────────────────────────────────────────────

const express = require("express");

// Required FIRST, before any module that reads configuration. This single
// require both loads .env and validates it, so by the time the route modules
// below are evaluated, config is known-good — or the process has already exited.
const config = require("./config/env");

const db = require("./db/client");
const authRoutes = require("./routes/auth");
const eventRoutes = require("./routes/events");

const app = express();

// ─── Request logging ─────────────────────────────────────────────────────────
//
// ⚠️ REGISTERED BEFORE THE BODY PARSERS, AND THE ORDER IS THE WHOLE POINT.
//    It was the other way round, and that silently lost log lines: `express.json()`
//    throws on a malformed body, which jumps straight to the error handler at the
//    bottom of this file — skipping every middleware in between. So a request with
//    a broken JSON body was answered with a 400 that appeared in NO log.
//
//    Those are precisely the requests you most want a record of: a client that has
//    started sending garbage, or somebody probing the endpoint. Verified by
//    running it — before the swap, a truncated POST body produced a 400 with no
//    log line; after, the request is logged and then rejected.
//
//    The generalisable rule: observability middleware goes as early as possible in
//    the chain, because anything registered before it can fail without being seen.
//    Logging is not a step in request handling; it is a wrapper around all of it.
//
// Silenced under test — not cosmetic: Jest interleaves stdout across tests, so a
// line per request buries genuine assertion failures in scrollback. Logging is for
// operators, and a test run has no operator.
//
// ⚠️ NOTE WHAT IS LOGGED: method and path only. Never the body, never the
//    Authorization header, never req.user. The previous version of routes/events.js
//    logged `req.body` and `req.user`, which put participant names and email
//    addresses into stdout — and stdout in any real deployment is shipped to a log
//    aggregator, retained for months, searchable by people who have no business
//    reading user email addresses. Request logs are metadata, not payloads.
if (!config.isTest) {
  app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
  });
}

// ─── Body parsers ────────────────────────────────────────────────────────────
// `limit` is not decoration. The default is 100kb, which is generous for an API
// whose largest legitimate body is a few hundred bytes of event text. Every byte
// allowed is a byte an unauthenticated caller can make the process parse, so the
// limit is a cheap bound on that. Lowering it is free; discovering you needed it
// is not.
app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: true, limit: "10kb" }));

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use("/", authRoutes); // POST /register, POST /login, GET /profile
app.use("/events", eventRoutes); // GET/POST /events, PUT/DELETE /events/:id, ...

// ─── Health check ────────────────────────────────────────────────────────────
// Deliberately does no work: no database call, no dependency check. This endpoint
// answers "is this process alive and serving HTTP", which is what a Kubernetes
// LIVENESS probe asks — and a liveness probe that fails when the database is down
// causes the orchestrator to kill and restart a perfectly healthy app, turning a
// database blip into a rolling outage of the whole deployment.
//
// The dependency-checking endpoint is a READINESS probe, and it is a different
// URL with different semantics ("should I be sent traffic right now"): /ready,
// directly below.
app.get("/health", (req, res) => {
  res.status(200).json({
    success: true,
    message: "Virtual Event Platform API is running.",
    timestamp: new Date().toISOString(),
  });
});

// ─── Readiness check ─────────────────────────────────────────────────────────
// The counterpart to /health, and the only probe allowed to touch the database.
// A failing ping answers 503 "not ready", which makes the orchestrator stop
// routing traffic here — it does NOT restart the process. Wiring this URL to a
// liveness probe would undo that distinction and bring back the rolling-outage
// problem described above.
//
// 503 rather than 500: the server is working correctly and is telling the caller
// that a dependency is unavailable right now, which is what 503 means and what
// load balancers expect from a probe. The body says only "not ready" — the driver
// error can contain the host and, on some failures, connection-string fragments,
// so it goes to the server log (name and message only) and never to the caller.
app.get("/ready", async (req, res) => {
  try {
    await db.ping();
    return res.status(200).json({ success: true, message: "Ready." });
  } catch (err) {
    if (!config.isTest) {
      console.error(`Readiness check failed: ${err.name}: ${err.message}`);
    }
    return res.status(503).json({ success: false, message: "Not ready." });
  }
});

// ─── 404 for anything unmatched ──────────────────────────────────────────────
// Must be registered AFTER every real route. Express matches middleware in
// registration order, so a catch-all placed earlier would swallow everything
// below it.
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.method} ${req.path} not found.`,
  });
});

// ─── Global error handler ────────────────────────────────────────────────────
// Express identifies an error handler by ARITY: exactly four declared parameters.
// Drop `next` and it silently becomes ordinary middleware that never runs on
// error — one of the few places in JavaScript where an unused parameter is
// load-bearing, which is why it is marked for the linter rather than deleted.
//
// Express 5 changed something important here: a rejected promise from an async
// route handler is now forwarded to this handler automatically. In Express 4 it
// vanished, and the client hung until timeout. That is why the routes can `await`
// without wrapping every handler in try/catch — though the existing handlers do
// anyway, which is belt-and-braces rather than wrong.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // A malformed JSON body is the one error worth distinguishing, because the old
  // handler got it wrong. `express.json()` throws a SyntaxError with `status: 400`
  // when the body will not parse — and returning 500 for that is a lie: the
  // server is fine, the request was invalid. A 500 also tells the caller "retry
  // later", which will fail identically forever.
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({
      success: false,
      message: "Request body is not valid JSON.",
    });
  }

  // Same reasoning for a body over the limit set above.
  if (err.type === "entity.too.large") {
    return res.status(413).json({
      success: false,
      message: "Request body is too large.",
    });
  }

  // Anything else is genuinely unexpected. Log the full error server-side —
  // that is the only copy of the stack trace anyone will ever get — and return a
  // deliberately vague message. Error text leaks implementation details (library
  // versions, file paths, SQL fragments), and an attacker reads error messages
  // as free reconnaissance.
  console.error("Unhandled error:", err);
  return res.status(500).json({
    success: false,
    message: "An unexpected error occurred.",
  });
});

module.exports = app;
