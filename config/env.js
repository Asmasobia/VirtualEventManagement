// ─────────────────────────────────────────────────────────────────────────────
//  ONE PLACE THAT READS process.env, VALIDATES IT, AND REFUSES TO START IF IT
//  IS WRONG.
//
//  Why this file exists at all — three concrete bugs it removes:
//
//  1. `dotenv.config()` was being called in four separate files (app.js,
//     routes/auth.js, middleware/auth.js, services/emailService.js). That is
//     harmless but it means nothing owns configuration, so nothing can validate
//     it. Load order also becomes load-order-dependent: whichever module is
//     required first wins, and a module required BEFORE dotenv runs sees
//     undefined. Centralising it makes "config is loaded" a fact, not a hope.
//
//  2. `JWT_EXPIRES_IN` was read straight from the environment and handed to
//     `jwt.sign()`. If it is missing, `expiresIn: undefined` does NOT throw and
//     does NOT default — jsonwebtoken simply omits the `exp` claim and mints a
//     token that is valid FOREVER. A missing line in a .env file silently turns
//     every login into a permanent credential. That is the kind of failure you
//     cannot see in a passing test suite, which is exactly why it belongs in a
//     startup check.
//
//  3. `JWT_SECRET` missing is worse than it looks: `jwt.verify(token, undefined)`
//     throws, so every request 401s — the app "runs" and is entirely broken.
//     Failing at boot with a readable message beats a healthy process serving
//     nothing but 401s.
//
//  THE GENERAL PRINCIPLE, worth carrying to other projects: validate
//  configuration ONCE, at startup, and crash loudly. A process that refuses to
//  boot is a deployment failure — visible, alarmed on, and rolled back
//  automatically. A process that boots and misbehaves is an incident. Kubernetes
//  makes this concrete: a container that exits non-zero gets CrashLoopBackOff and
//  never receives traffic, whereas one that starts happily passes its readiness
//  probe and gets sent real users.
// ─────────────────────────────────────────────────────────────────────────────

require("dotenv").config();

const isTest = process.env.NODE_ENV === "test";

// ─── Test-environment defaults ───────────────────────────────────────────────
// A deliberate exception, and it needs justifying because "defaults for secrets"
// is normally an anti-pattern.
//
// The test suite must run on a machine with no `.env` at all — that is the whole
// point of CI. Without these, GitHub Actions would need JWT_SECRET configured as
// a repository secret just to run unit tests, which is both annoying and
// misleading: it implies the value matters when any random string would do.
//
// The safety property that makes this acceptable: these values apply ONLY when
// NODE_ENV === "test". They can never leak into a real deployment, because a
// real deployment is not running with NODE_ENV=test. If it is, that is the bug.
const TEST_DEFAULTS = {
  JWT_SECRET: "test-only-secret-not-used-outside-jest",
  JWT_EXPIRES_IN: "1h",
  // Localhost, no credentials, so safe to publish. Note the KEY: tests read
  // MONGODB_TEST_URI, never MONGODB_URI — see the Database section below for why.
  MONGODB_TEST_URI: "mongodb://127.0.0.1:27017/virtual_events_test",
};

/**
 * Read one variable, applying a test default if we are in a test run.
 *
 * `fallback` is for values that genuinely have a sensible default in every
 * environment (PORT). It is NOT for secrets — a defaulted secret is a secret
 * you will ship by accident.
 */
function read(name, { fallback = undefined } = {}) {
  const raw = process.env[name];

  // `.trim()` because a trailing space in a .env file is invisible and produces
  // errors that make no sense: `JWT_EXPIRES_IN="1h "` is rejected by
  // jsonwebtoken's duration parser with a message about the wrong string.
  const value = typeof raw === "string" ? raw.trim() : raw;

  if (value) return value;
  if (isTest && TEST_DEFAULTS[name]) return TEST_DEFAULTS[name];
  return fallback;
}

// ─── Collect every problem before reporting ──────────────────────────────────
// Deliberately NOT throwing on the first missing variable. Someone setting the
// app up for the first time with an empty .env should learn all five things they
// need to fix in one run, not discover them one restart at a time. The same
// reasoning as a form that validates every field at once instead of the first.
const problems = [];

const JWT_SECRET = read("JWT_SECRET");
if (!JWT_SECRET) {
  problems.push(
    "JWT_SECRET is required. Generate one with: node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\"",
  );
} else if (!isTest && JWT_SECRET.startsWith("replace-me")) {
  // Catches the commonest onboarding mistake: copying .env.example to .env and
  // filling in nothing. Without this check the app runs with a secret that is
  // published in the repository, which is indistinguishable from having no
  // authentication at all.
  problems.push(
    "JWT_SECRET is still the placeholder from .env.example. Replace it with a real random value.",
  );
} else if (!isTest && JWT_SECRET.length < 32) {
  // Not a magic number: the signature is HMAC-SHA256, whose block size is 64
  // bytes and output 32. A secret shorter than the digest adds no strength over
  // a 32-byte one, and short secrets are what make offline brute-forcing of a
  // captured token feasible. 32 is the floor, not a target.
  problems.push(
    `JWT_SECRET is only ${JWT_SECRET.length} characters. Use at least 32 (48 random bytes is a good default).`,
  );
}

const JWT_EXPIRES_IN = read("JWT_EXPIRES_IN");
if (!JWT_EXPIRES_IN) {
  problems.push(
    "JWT_EXPIRES_IN is required. Without it, jsonwebtoken omits the exp claim and issues tokens that never expire.",
  );
}

// PORT gets a real fallback: there is no security consequence to guessing, and
// requiring it would break `node server.js` for someone just trying the app.
const PORT = Number(read("PORT", { fallback: "3000" }));
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  problems.push(
    `PORT must be an integer between 1 and 65535, got "${process.env.PORT}".`,
  );
}

// ─── Database ────────────────────────────────────────────────────────────────
// Required, with no non-test fallback: guessing a database host is how a
// development run ends up writing to the wrong instance.
//
// This checks the SHAPE only. Whether the host is reachable is a connection
// question, answered when the client connects at startup (and by the readiness
// probe afterwards). What this catches is the cheap, common mistakes — a missing
// value, a pasted `http://` URL, a copied placeholder, no database name — at the
// same moment as every other config error, instead of on the first query.
//
// A hosted connection string embeds a password, so NONE of the messages below
// echo the value back. An error line is a log line, and logs outlive the process.
//
// ⚠️ TESTS READ A DIFFERENT VARIABLE. The suite drops its database before every
//    test, so the one thing it must never do is resolve to the development
//    database. It used to: tests read MONGODB_URI, the test default only applied
//    when that was unset, and dotenv loads `.env` in tests too — so on any machine
//    with a real `.env`, the "test" run was pointed at `virtual_events`. Nothing
//    broke only because nothing dropped anything yet.
//
//    A separate variable makes the two impossible to confuse: `.env` can hold the
//    dev MONGODB_URI and the test run never looks at it. The `_test` suffix rule
//    below is the second lock — even a deliberately set MONGODB_TEST_URI cannot
//    aim the suite at a database whose name does not say it is disposable.
const MONGODB_VAR = isTest ? "MONGODB_TEST_URI" : "MONGODB_URI";
const MONGODB_URI = read(MONGODB_VAR);
// Captures the database name: the first path segment after the host, stopping
// at the query string.
const MONGODB_DB_PATTERN = /^mongodb(\+srv)?:\/\/[^/\s]+\/([^/?\s]+)/;
let mongodbDbName;
if (!MONGODB_URI) {
  problems.push(
    `${MONGODB_VAR} is required, e.g. mongodb://127.0.0.1:27017/virtual_events`,
  );
} else if (!/^mongodb(\+srv)?:\/\/[^/\s]+/.test(MONGODB_URI)) {
  problems.push(
    `${MONGODB_VAR} must start with mongodb:// or mongodb+srv:// followed by a host.`,
  );
} else if (MONGODB_URI.includes("replace-me")) {
  problems.push(
    `${MONGODB_VAR} is still the placeholder from .env.example. Replace it with a real connection string.`,
  );
} else if (!MONGODB_DB_PATTERN.test(MONGODB_URI)) {
  // The driver would otherwise silently use its default database ("test"), and
  // the app would work while writing to a database nobody chose.
  problems.push(
    `${MONGODB_VAR} must name a database after the host, e.g. .../virtual_events.`,
  );
} else {
  mongodbDbName = MONGODB_URI.match(MONGODB_DB_PATTERN)[2];

  if (isTest && !mongodbDbName.endsWith("_test")) {
    problems.push(
      `${MONGODB_VAR} must name a database ending in "_test". The test suite drops its database before every test, so it refuses to run against one whose name does not mark it as disposable.`,
    );
  } else if (isTest && process.env.JEST_WORKER_ID) {
    // One database PER JEST WORKER. Jest runs test files in parallel processes,
    // and two files sharing one database would drop each other's data mid-test —
    // a flaky failure that only appears when the timing lines up. The usual
    // workaround is `--runInBand`, which invariant 1 exists to avoid. A suffix
    // per worker keeps parallelism and isolation both. Within a worker, files run
    // one after another, so a single database per worker is enough.
    mongodbDbName = `${mongodbDbName}_${process.env.JEST_WORKER_ID}`;
  }
}

if (problems.length > 0) {
  // Writing to stderr and exiting, rather than throwing, because a thrown error
  // here prints a stack trace whose top frame is this file — noise that buries
  // the actual message. The reader needs the list, not the call site.
  console.error(
    "\n❌ Invalid configuration. Fix the following in your .env file:\n",
  );
  for (const problem of problems) console.error(`   • ${problem}`);
  console.error("\n   See .env.example for the full list of variables.\n");
  process.exit(1);
}

// ─── Email configuration ─────────────────────────────────────────────────────
// Email is intentionally NOT required. The app is fully usable without it —
// every send is fire-and-forget and already wrapped in a catch — so refusing to
// boot over a missing SMTP host would make a non-essential feature into a hard
// dependency.
//
// But silence was the old bug: emailService read EMAIL_SERVICE, which no .env
// ever defined, while EMAIL_HOST/EMAIL_PORT were defined and never read. So
// nodemailer got `service: undefined` with no host, every send failed, and the
// catch block hid it. "Configured wrong" and "deliberately disabled" looked
// identical.
//
// The fix is to make the distinction explicit: build a transport config here,
// return null when there is nothing usable, and let the caller log once at
// startup that email is disabled. A feature that is off should say so.
function buildEmailConfig() {
  const user = read("EMAIL_USER");
  const pass = read("EMAIL_PASS");
  const service = read("EMAIL_SERVICE");
  const host = read("EMAIL_HOST");
  const port = read("EMAIL_PORT");

  // Explicit SMTP host wins over the provider shortcut, because a host is the
  // more specific instruction — and it is what a local mail-catcher (MailHog,
  // Mailpit) needs. A local catcher also legitimately has no credentials, so
  // user/pass must not be required on this branch.
  if (host) {
    return {
      host,
      port: port ? Number(port) : 587,
      // `secure: true` means TLS from the first byte, which is port 465 only.
      // 587 and 1025 use STARTTLS, which nodemailer negotiates when secure is
      // false. Getting this backwards produces a connection that hangs rather
      // than an error, so it is derived rather than configured.
      secure: Number(port) === 465,
      auth: user && pass ? { user, pass } : undefined,
    };
  }

  // The shortcut form ("gmail", "outlook") only works with credentials — it
  // resolves to a real provider's authenticated SMTP endpoint.
  if (service && user && pass) {
    return { service, auth: { user, pass } };
  }

  return null;
}

const emailConfig = buildEmailConfig();

// ─── Export a frozen snapshot ────────────────────────────────────────────────
// Frozen so that no module can reach in and mutate configuration at runtime.
// This is not paranoia about malice; it is about making the config a fact you
// can reason about. If `config.JWT_SECRET` can change after boot, then the
// startup validation above proves nothing about the value in use later.
//
// Also note what is NOT exported: `process.env` itself. Every other module now
// imports from here, so there is exactly one list of the variables this app
// reads — greppable, documentable, and impossible to drift from .env.example
// without someone noticing.
module.exports = Object.freeze({
  env: process.env.NODE_ENV || "development",
  isTest,
  isProduction: process.env.NODE_ENV === "production",
  PORT,
  mongodb: Object.freeze({
    uri: MONGODB_URI,
    // Exported separately rather than left inside the URI, because in tests it
    // differs from the URI's path (the per-worker suffix). Rewriting the URI
    // instead would also move the default authSource, which the driver takes
    // from that same path segment — a hosted test cluster would then fail auth.
    dbName: mongodbDbName,
  }),
  jwt: Object.freeze({
    secret: JWT_SECRET,
    expiresIn: JWT_EXPIRES_IN,
  }),
  email: Object.freeze({
    // `enabled` exists so callers never have to infer intent from a null check
    // scattered across three files.
    enabled: emailConfig !== null,
    from: read("EMAIL_FROM") || read("EMAIL_USER"),
    transport: emailConfig,
  }),
});
