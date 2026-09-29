// ─────────────────────────────────────────────────────────────────────────────
//  THE PROCESS ENTRY POINT. The only file in the repository that opens a socket.
//
//  Nothing imports this file — not the tests, not the routes. That is the point:
//  the side effect of listening now happens in exactly one place, reached only by
//  running it. `app.js` builds the application; this file runs it.
// ─────────────────────────────────────────────────────────────────────────────

const app = require("./app");
const config = require("./config/env");

const server = app.listen(config.PORT, () => {
  console.log(`🚀 Server running on http://localhost:${config.PORT}`);
  console.log(`📋 Health check: http://localhost:${config.PORT}/health`);
  console.log(`🔧 Environment: ${config.env}`);

  // Say out loud whether an optional feature is on. The old code could not do
  // this, because "email misconfigured" and "email deliberately off" looked
  // identical — both produced silence, and the failure only appeared as a
  // console.error inside a swallowed catch, long after startup.
  if (config.email.enabled) {
    console.log(`📧 Email enabled (from: ${config.email.from})`);
  } else {
    console.log(
      "📭 Email disabled — no EMAIL_HOST or EMAIL_SERVICE configured.",
    );
  }
});

// ─── Graceful shutdown ───────────────────────────────────────────────────────
//
//  WHAT PROBLEM THIS SOLVES, concretely. Without it, a deploy looks like this:
//  the orchestrator sends SIGTERM, Node's default handler exits the process
//  immediately, and every request currently mid-flight dies with a connection
//  reset. The client sees a network error, not a status code — so it cannot tell
//  a failed write from a successful one it never got the answer to. For a POST
//  that already mutated state, that ambiguity is the whole problem: retrying may
//  double-apply, not retrying may lose the write.
//
//  `server.close()` fixes the shape of it. It stops accepting NEW connections
//  immediately, then waits for in-flight responses to finish before the callback
//  fires. Requests that were already accepted get a real answer.
//
//  ⚠️ THE PART PEOPLE MISS: SIGTERM is not the signal to stop serving. In
//     Kubernetes, SIGTERM and endpoint removal from the Service are concurrent,
//     not ordered — load balancers can keep routing to this pod for a second or
//     two after the signal arrives. A container that exits instantly on SIGTERM
//     therefore drops traffic that was sent to it legitimately. The correct
//     sequence is: keep serving, stop accepting, drain, exit. A `preStop` sleep
//     in the pod spec is the usual companion to this handler, and it belongs with
//     the Kubernetes work rather than here.
//
//  Both signals are handled because they arrive from different places: SIGTERM
//  from `docker stop` and from Kubernetes, SIGINT from Ctrl-C in a terminal.
//  Handling only one means the behaviour differs between your laptop and
//  production, which is exactly where surprises come from.

const SHUTDOWN_TIMEOUT_MS = 10_000;

function shutdown(signal) {
  console.log(`\n${signal} received — shutting down gracefully.`);

  // A hard deadline, armed BEFORE close() is called. A single request stuck on a
  // hanging upstream would otherwise keep the process alive forever, and the
  // orchestrator would eventually SIGKILL it — which is the ungraceful exit this
  // handler exists to avoid, just delayed. Better to exit non-zero ourselves,
  // deliberately and with a log line explaining why.
  //
  // `.unref()` so this timer is not itself a reason for the event loop to stay
  // alive: if the drain finishes in 40ms, we should exit in 40ms, not sit here
  // for the remaining 9.96 seconds.
  const forceExit = setTimeout(() => {
    console.error(
      `Could not close connections within ${SHUTDOWN_TIMEOUT_MS}ms — forcing exit.`,
    );
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  server.close((err) => {
    if (err) {
      console.error("Error during shutdown:", err);
      process.exit(1);
    }
    console.log("✅ All connections closed. Goodbye.");
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ─── Last-resort handlers ────────────────────────────────────────────────────
//
//  These deliberately EXIT rather than log and continue, which is the opposite of
//  what feels safe, so it needs justifying.
//
//  An uncaught exception means a stack unwound to the top without anyone handling
//  it. Whatever operation was in progress stopped halfway, and no code ran to
//  clean it up — so the process is now in a state nobody designed or tested. It
//  might be fine. It might be holding a half-written record or a leaked
//  connection. You cannot tell from here, and "probably fine" is not a property
//  you want in the thing serving your users.
//
//  A crash is honest and recoverable: the orchestrator restarts a fresh process
//  with known-good state, and the crash is visible in metrics and alerts. A
//  process that logs and limps on hides the failure and corrupts data quietly.
//  Crash loudly, restart clean.
//
//  `unhandledRejection` is the same argument for promises. Node 15+ already
//  terminates on these by default; the handler exists to log the reason first,
//  because the default message alone is often uselessly terse.
process.on("uncaughtException", (err) => {
  console.error("💥 Uncaught exception — exiting:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("💥 Unhandled promise rejection — exiting:", reason);
  process.exit(1);
});
