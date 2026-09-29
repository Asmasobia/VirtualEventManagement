// ─────────────────────────────────────────────────────────────────────────────
//  OUTBOUND EMAIL. Three fixes over the previous version, in order of severity.
//
//  1. IT NEVER WORKED, AND SAID NOTHING. This module read `process.env.EMAIL_SERVICE`,
//     which no `.env` in this repository ever defined. Meanwhile `.env` defined
//     EMAIL_HOST and EMAIL_PORT, which nothing read. nodemailer therefore received
//     `{ service: undefined, auth: {...} }` — no host, no port, no provider — and
//     every send failed. The failure was caught and console.error'd inside a
//     fire-and-forget promise, so the symptom was "the app works fine, emails
//     just never arrive."
//
//     The lesson generalises past this bug: a config key read but never set, and a
//     config key set but never read, are the same mistake seen from two sides, and
//     neither one is a syntax error. Nothing in JavaScript will tell you. The
//     defence is to funnel configuration through one module that names every
//     variable exactly once — which is what config/env.js now does.
//
//  2. A NEW TRANSPORT PER EMAIL. `createTransporter()` was called inside each
//     send function, so every message built a fresh transport with its own
//     connection pool, then dropped it. That means a full TCP connect plus TLS
//     handshake plus SMTP AUTH per message — hundreds of milliseconds of pure
//     overhead, and on a provider like Gmail, a reliable way to get rate-limited
//     for connection churn. A transport is a long-lived pooled resource; build it
//     once.
//
//  3. RECIPIENT ADDRESSES IN THE LOGS. Every send logged the destination address
//     on success. Same objection as the debug logging removed from routes/events.js:
//     stdout ends up in a searchable, long-retention aggregator, and a log line is
//     not a place to keep personal data. Success is now logged without the address.
//
//  ⚠️ ARCHITECTURAL NOTE, and the honest limitation of this whole file: these sends
//     are fire-and-forget from the request handler. If the process dies between
//     committing a registration and the SMTP call completing, the email is simply
//     lost — nothing retries it, and nothing records that it was owed. That is an
//     acceptable trade for a courtesy notification and NOT acceptable for anything
//     a user depends on (a password reset, a receipt). The fix for those is to
//     write the intent to the database in the same transaction as the state change
//     and have a worker deliver it — the transactional outbox pattern. Worth
//     naming here so the choice reads as deliberate.
// ─────────────────────────────────────────────────────────────────────────────

const nodemailer = require("nodemailer");
const config = require("../config/env");

// ─────────────────────────────────────────────
//  One transport, built lazily, reused forever
// ─────────────────────────────────────────────
// Lazy rather than at module load so that requiring this file has no side effect
// — the same principle that moved `listen()` out of app.js. A test that imports
// a route which imports this module should not open a socket to an SMTP server.
let transporter = null;

function getTransporter() {
  if (!config.email.enabled) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport(config.email.transport);
  }
  return transporter;
}

/**
 * Send one message, or quietly do nothing if email is not configured.
 *
 * Centralising the send means the "is email even on?" check exists once instead of
 * three times, and every caller gets identical error handling. The functions below
 * become what they should be: templates.
 */
async function send({ to, subject, text }) {
  const mailer = getTransporter();

  if (!mailer) {
    // Not an error. Email being off is a supported configuration — see
    // config/env.js for why it is optional. Logged at debug volume so that a
    // developer wondering where their email went has something to find, without
    // filling the log with a line per registration in a deployment that has
    // deliberately disabled it.
    if (!config.isTest) {
      console.log(`✉️  Email disabled — skipped "${subject}".`);
    }
    return;
  }

  try {
    await mailer.sendMail({ from: config.email.from, to, subject, text });
    // No recipient address in the success log — see note 3 above. The subject is
    // enough to tell which template fired.
    console.log(`✉️  Sent "${subject}".`);
  } catch (error) {
    // Rethrown, NOT swallowed. This is a deliberate change from the previous
    // version, which caught and logged here — meaning the caller could never
    // distinguish sent from failed, and the `.catch()` at every call site was
    // dead code that could never run.
    //
    // Now the contract is honest: this function rejects on failure, and each
    // caller decides. The route handlers attach `.catch()` because they genuinely
    // do not want a dead SMTP server to fail a registration; a future password
    // reset would want to await it and surface the failure.
    console.error(`✉️  Failed to send "${subject}": ${error.message}`);
    throw error;
  }
}

// ─────────────────────────────────────────────
//  Welcome email — sent on user registration
// ─────────────────────────────────────────────
async function sendWelcomeEmail(user) {
  return send({
    to: user.email,
    subject: "Welcome to Virtual Event Platform!",
    text:
      `Hi ${user.name},\n\n` +
      `Welcome to the Virtual Event Platform!\n\n` +
      `Your account details:\n` +
      `  Name  : ${user.name}\n` +
      `  Email : ${user.email}\n` +
      `  Role  : ${user.role}\n\n` +
      (user.role === "organizer"
        ? `As an organizer, you can create and manage events.\n\n`
        : `As an attendee, you can browse and register for events.\n\n`) +
      `If you did not create this account, please ignore this email.\n\n` +
      `- Virtual Event Platform`,
  });
}

// ─────────────────────────────────────────────
//  Event registration confirmation
// ─────────────────────────────────────────────
async function sendEventRegistrationEmail(user, event) {
  return send({
    to: user.email,
    subject: `Registration Confirmed: ${event.title}`,
    text:
      `Hi ${user.name},\n\n` +
      `Your registration has been confirmed for the following event:\n\n` +
      `  Event     : ${event.title}\n` +
      `  Date      : ${new Date(event.date).toDateString()}\n` +
      `  Time      : ${event.time}\n` +
      `  Details   : ${event.description}\n` +
      `  Organizer : ${event.organizerName}\n\n` +
      `We look forward to seeing you there!\n\n` +
      `To cancel, log in and unregister from the event.\n\n` +
      `- Virtual Event Platform`,
  });
}

// ─────────────────────────────────────────────
//  Event update notification to all participants
// ─────────────────────────────────────────────
async function sendEventUpdateEmail(participants, event) {
  // ⚠️ `allSettled`, not `all`, and the difference is behavioural rather than
  //    stylistic. `Promise.all` rejects on the FIRST failure and abandons the
  //    rest — so one bad address among fifty participants would stop the other
  //    forty-nine from being attempted. `allSettled` waits for every send and
  //    reports, which is what "notify everyone" actually means.
  //
  //    This is also why the map below does not need a try/catch: `send` rejects,
  //    and allSettled records the rejection instead of propagating it.
  const results = await Promise.allSettled(
    participants.map((participant) =>
      send({
        to: participant.email,
        subject: `Event Updated: ${event.title}`,
        text:
          `Hi ${participant.name},\n\n` +
          `An event you registered for has been updated:\n\n` +
          `  Event    : ${event.title}\n` +
          `  New Date : ${new Date(event.date).toDateString()}\n` +
          `  New Time : ${event.time}\n` +
          `  Details  : ${event.description}\n\n` +
          `Please update your schedule accordingly.\n\n` +
          `- Virtual Event Platform`,
      }),
    ),
  );

  // A count, not a list of addresses. Enough for an operator to notice that
  // deliveries are failing and go look at the SMTP logs, without this line
  // becoming a record of who is registered for what.
  const failed = results.filter((r) => r.status === "rejected").length;
  if (failed > 0) {
    console.error(
      `✉️  Event update: ${failed} of ${results.length} notifications failed.`,
    );
  }

  return { total: results.length, failed };
}

module.exports = {
  sendWelcomeEmail,
  sendEventRegistrationEmail,
  sendEventUpdateEmail,
};
