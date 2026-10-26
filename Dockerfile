# ─────────────────────────────────────────────────────────────────────────────
#  THE PRODUCTION IMAGE. One stage, because there is nothing to build: the app is
#  plain JavaScript, so a separate build stage would copy the same files twice and
#  add a layer of indirection with nothing to show for it. If a TypeScript step
#  ever arrives, that is the moment to split into build + runtime stages.
# ─────────────────────────────────────────────────────────────────────────────

# Alpine for size; nothing here needs glibc. Every dependency is pure JavaScript
# (bcryptjs, not the native bcrypt), so there is no binary that musl could break.
#
# Pinned to the major line, not to a digest. A digest pin is the stronger
# guarantee — `22-alpine` is a moving tag, and the same Dockerfile can build a
# different image next week — but it only stays secure if something bumps it,
# which means Dependabot or Renovate. Without that automation a digest pin freezes
# the base image and quietly stops receiving security patches. Major-line tag now,
# digest plus a bot later, never a digest with no bot.
FROM node:22-alpine

# ─── tini as PID 1 ───────────────────────────────────────────────────────────
#
#  The process started by CMD becomes PID 1 in the container, and the kernel
#  treats PID 1 specially: a signal with no handler installed is IGNORED rather
#  than given its default action. Node installs no SIGTERM handler of its own, so
#  as PID 1 it ignores SIGTERM until server.js registers one — which it does only
#  after the database connects. During that window (up to the 5s
#  server-selection timeout) `docker stop` is ignored, Docker waits its 10s grace
#  period, and then SIGKILLs. That is precisely the case server.js's comment
#  describes as getting "Node's default behaviour — immediate exit", and outside
#  a container it does. Inside one, without this, it does not.
#
#  tini runs as PID 1 instead, forwards signals to Node, and reaps zombies. Node is
#  then an ordinary process with ordinary default signal behaviour.
#
#  Why bake it into the image rather than rely on `docker run --init` or compose's
#  `init: true`: Kubernetes has no such flag. An image that only behaves correctly
#  when its runner remembers an option is an image that misbehaves in production.
RUN apk add --no-cache tini

WORKDIR /app

# Set before `npm ci` as well as for runtime. The app only uses it to report the
# environment at startup, but libraries (Express among them) read it directly and
# switch off development-only behaviour such as verbose error pages.
ENV NODE_ENV=production

# ─── Dependencies first, source second ───────────────────────────────────────
#
#  Docker caches each layer and reuses it until something it depends on changes.
#  Copying only the manifests first means the install layer is invalidated by a
#  dependency change, not by every edit to a route handler — so a source-only
#  rebuild skips `npm ci` entirely. Copying everything up front would reinstall
#  every package on every commit.
COPY package.json package-lock.json ./

# `npm ci`, not `npm install`: it installs exactly what the lockfile says and fails
# if the lockfile and package.json disagree, instead of quietly resolving fresh
# versions. The image then contains the dependency tree the test suite ran against.
#
# `--omit=dev` keeps jest, eslint, prettier and nodemon out of the image: less to
# ship, and less code an attacker could find already installed.
#
# `--ignore-scripts` refuses to run any package's install hooks. An install script
# is arbitrary code from the registry running at build time, and it is the usual
# vehicle for a compromised package. No production dependency here has one (only
# two dev-only packages do), so this costs nothing today, and if a future dependency
# needs one the build fails visibly rather than running it silently.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# What this copies is decided by .dockerignore, which is an allowlist — see there.
COPY . .

# ─── Run unprivileged ────────────────────────────────────────────────────────
#
#  The official image ships a `node` user; the default is root. A process that
#  only serves HTTP on an unprivileged port has no reason to be root, and running
#  as root turns any remote-code-execution bug into root inside the container,
#  one kernel bug away from root on the host.
#
#  The files above stay owned by root (no --chown). The app needs to read its
#  code, never to write it, so a compromised process cannot rewrite its own source.
USER node

# Documentation only — this does not publish anything. It records the port
# config/env.js falls back to when PORT is unset.
EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]

# Exec form (a JSON array), and `node` directly rather than `npm start`. The shell
# form `CMD node server.js` runs under /bin/sh, which does not forward signals to
# its child, so SIGTERM stops at the shell and the graceful-shutdown path never
# runs. `npm start` puts npm between tini and Node; whether npm forwards signals
# has varied between npm versions, which makes it one more thing to verify for no
# benefit — the start script is just `node server.js` anyway.
CMD ["node", "server.js"]
