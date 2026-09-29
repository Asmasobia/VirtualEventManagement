// ─────────────────────────────────────────────────────────────────────────────
//  ESLint 9 "flat config".
//
//  Why the file looks nothing like the `.eslintrc.json` you may have seen: ESLint 9
//  replaced the cascading-config system with a plain exported array. Each element
//  is an object saying "for these files, apply these settings", and later elements
//  override earlier ones. No `extends` chain to reason about, no automatic merging
//  of configs found in parent directories — the array IS the resolution order.
//
//  The practical consequence, and the thing that trips people up: order matters,
//  and the LAST matching entry wins. That is why `eslint-config-prettier` goes at
//  the bottom.
//
//  WHAT A LINTER IS FOR HERE, since this project already has tests: tests tell you
//  the code does what you asked. A linter tells you about code that is *suspicious
//  regardless of behaviour* — an unused variable (usually a rename that was only
//  half applied), `==` where you meant `===`, a promise created and never awaited.
//  Those are the bugs tests miss, because the test only exercises the paths you
//  thought of.
// ─────────────────────────────────────────────────────────────────────────────

const js = require("@eslint/js");
const jest = require("eslint-plugin-jest");
const prettier = require("eslint-config-prettier");

module.exports = [
  // ─── What to skip ──────────────────────────────────────────────────────────
  // `ignores` in an entry with no other keys is a global ignore. node_modules is
  // ignored by default, but coverage output is not, and linting generated
  // instrumentation produces hundreds of meaningless errors.
  {
    ignores: ["node_modules/**", "coverage/**"],
  },

  // ─── Baseline recommended rules ────────────────────────────────────────────
  // The rules the ESLint team considers uncontroversial: things that are almost
  // certainly mistakes rather than style choices. Worth starting from these rather
  // than hand-picking, because the list encodes years of real bugs.
  js.configs.recommended,

  // ─── This project's source ────────────────────────────────────────────────
  {
    files: ["**/*.js"],

    // ESLint 9 defaults this to "warn". Promoted to "error" so that a suppression
    // which no longer suppresses anything FAILS the build instead of scrolling past
    // in a wall of warnings. The failure mode it prevents: someone silences a rule
    // for a real reason, the code is later rewritten so the rule no longer fires,
    // and the comment stays — now silently switching the rule off for whatever gets
    // written at that spot next. Warnings that nobody is required to fix are just
    // slower-moving debt.
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },

    languageOptions: {
      ecmaVersion: 2024,

      // CommonJS, not ESM. This has to be declared: without it ESLint parses the
      // files as modules and flags `require` and `module.exports` as undefined.
      // The whole codebase is `require()`-based, and converting to ESM is a
      // separate decision, not a side effect of adding a linter.
      sourceType: "commonjs",

      globals: {
        // Declaring the runtime's globals is what makes `no-undef` useful. Without
        // this, every `process`, `console` and `Buffer` is reported as undefined —
        // which trains you to ignore the linter, the worst possible outcome.
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        module: "writable",
        require: "readonly",
        exports: "writable",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
      },
    },
    rules: {
      // ⚠️ THE RULE THAT NEEDS THE MOST EXPLANATION, because a naive setting here
      //    breaks Express. An Express error handler is identified by ARITY: it must
      //    declare exactly four parameters, and the fourth (`next`) is usually
      //    unused. Delete it to satisfy a linter and the function silently stops
      //    being an error handler — it becomes ordinary middleware that never runs
      //    on error, and errors fall through to Express's default HTML response.
      //
      //    THE TEMPTING FIX IS WRONG. Adding `^next$` to argsIgnorePattern makes
      //    the warning go away, and it also switches off a genuine bug signal:
      //    middleware that declares `next`, never calls it, and never sends a
      //    response leaves the request hanging until the client times out — no
      //    error, no log, just a stalled connection. An unused `next` is USUALLY a
      //    bug. It is load-bearing in exactly one place, the error handler.
      //
      //    So the rule stays strict and app.js carries an explicit
      //    `// eslint-disable-next-line no-unused-vars` at that one site. That is
      //    the better trade in both directions: the suppression is visible at the
      //    place it applies and documents WHY the parameter must stay, and every
      //    other unused `next` still gets reported. A narrow, annotated exception
      //    beats a broad silent one.
      //
      //    `^_` covers the other legitimate case — the `const { password: _hash,
      //    ...rest }` idiom, where a field is destructured purely to exclude it
      //    from the rest object and is never meant to be read.
      //
      //    `caughtErrors: "none"` because `catch (error) {}` where the error is
      //    genuinely irrelevant is a real pattern, and flagging it produces noise.
      //
      //    ⚠️ `reportUnusedDisableDirectives` is what surfaced all of this: it flags
      //       a disable comment that is suppressing nothing. Without it, stale
      //       suppressions accumulate — each one a small blind spot that outlives
      //       the problem it was added for, and none of them visible.
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
        },
      ],

      // `==` performs type coercion with rules almost nobody remembers correctly
      // (`"" == 0` is true; `null == undefined` is true but `null == 0` is false).
      // `null` is exempted because `x == null` is the idiomatic, readable way to
      // test "null or undefined" in one comparison.
      eqeqeq: ["error", "always", { null: "ignore" }],

      // A `var` is function-scoped and hoisted, so it leaks out of the block it
      // appears in. `let`/`const` are block-scoped, which is what the indentation
      // already implies.
      "no-var": "error",
      "prefer-const": "error",

      // ⚠️ The most valuable rule in this file for THIS codebase. It flags a
      //    promise used where a non-promise is expected — the classic being
      //    `if (somethingAsync())`, which is always truthy because a Promise object
      //    is truthy, so the condition passes whatever the eventual value is.
      //
      //    The repo has real fire-and-forget calls (the email sends) which are
      //    deliberate, so this cannot be set to forbid floating promises outright.
      //    What it does catch is the accidental version.
      "no-async-promise-executor": "error",
      "require-atomic-updates": "error",

      // `console` is the intended logging mechanism in this project, so the usual
      // `no-console` rule would be wrong here. Left off deliberately — turning it
      // on belongs with introducing a real structured logger (pino), which is a
      // separate change with its own reasoning.
      "no-console": "off",
    },
  },

  // ─── Tests ─────────────────────────────────────────────────────────────────
  // Jest injects `describe`, `test`, `expect` and friends as globals, so they must
  // be declared or `no-undef` fires on every line of the suite. The jest plugin
  // adds rules specific to test code — the most useful being a check for a test
  // that contains no assertion at all, which passes silently and proves nothing.
  {
    files: ["tests/**/*.js", "**/*.test.js"],
    plugins: { jest },
    languageOptions: {
      globals: {
        ...jest.environments.globals.globals,
      },
    },
    rules: {
      ...jest.configs["flat/recommended"].rules,
      "jest/expect-expect": "error",
    },
  },

  // ─── Prettier last ─────────────────────────────────────────────────────────
  // MUST be the final entry. It does not format anything — it switches OFF every
  // ESLint rule that concerns formatting (indentation, quotes, semicolons,
  // line length), so the two tools cannot disagree.
  //
  // The division of labour worth internalising: Prettier owns how the code LOOKS
  // and is not negotiable or configurable in any interesting way. ESLint owns what
  // the code MEANS. Arguing about formatting is a waste of review time; a
  // formatter ends the argument by removing the choice.
  prettier,
];
