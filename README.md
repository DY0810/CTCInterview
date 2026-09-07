# Feeding Brennen

A fullstack app for tracking restaurants, visits, and how much Brennen spends eating
out. This submission implements the restaurant API and visit logging from the
take-home challenge. See [WriteUp.md](./WriteUp.md) for decisions and verification.

## Stack

| Layer    | Tech                                             |
| -------- | ------------------------------------------------ |
| App      | Next.js 14 (App Router), TypeScript, Tailwind    |
| API      | Next.js Route Handlers (`app/api/*`), TypeScript |
| Database | PostgreSQL (`pg`)                                |

One Next.js app serves both the UI and the REST API. There is no separate
backend server: the API lives in route handlers under `app/api/`.

## Layout

```
.
├── client/            # the Next.js app: UI + REST API (route handlers) + DB layer
├── setup.sh           # one-command setup
├── SETUP.md           # setup & troubleshooting
├── HOW-IT-WORKS.md    # how the repo fits together (start here if you're new)
├── CHALLENGE.md       # the brief: what to build and how it's evaluated
└── WriteUp.md         # decisions, route examples, and verification
```

Inside `client/`: the UI is in `app/` (pages) and the REST API is in
`app/api/` (route handlers); `db/` holds the connection pool, migrations, and
seed script; `lib/` has the frontend fetch client and a shared error helper.

## Quick start

Install
[Docker Desktop](https://www.docker.com/products/docker-desktop/) and make sure
it's open and running.

```bash
git clone <your-fork-url> feeding-brennen
cd feeding-brennen
./setup.sh                  # database, dependencies, tables, sample data
cd client && npm run dev    # http://localhost:3000 (UI + API under /api)
```

That's it - there's no `.env` to configure. See **[SETUP.md](./SETUP.md)** for
prerequisites, what the script does, and troubleshooting.

When you're done, push your work to your fork and submit the link to it on the
**[submission form](https://forms.gle/sLZHGrs5FQvX4VjHA)** - see
[CHALLENGE.md](./CHALLENGE.md#submitting).

**On Windows:** run everything from WSL2 or Git Bash - `setup.sh` won't run in
PowerShell or `cmd.exe`. [SETUP.md](./SETUP.md#on-windows) has the details.

The home page lists restaurants. Open a restaurant to see its visits and total
spending, or log a new visit.

## Challenge

The original brief is preserved in [CHALLENGE.md](./CHALLENGE.md). Its references
to broken queries and unimplemented handlers describe the starter, not this version.

**Read [CHALLENGE.md](./CHALLENGE.md)** for the full brief: what to build, how
to verify your work, and exactly how submissions are evaluated.

**New to backend work?** Read
**[HOW-IT-WORKS.md](./HOW-IT-WORKS.md)** first - the request lifecycle end to
end, how a URL becomes a route handler, what the status codes mean, and what
every file is for.

The challenge is in two halves:

- **Part A (prescribed) - three tasks.** Fix the one planted bug, finish the
  Restaurant write API (`POST`, `PUT`, `DELETE`) against a fixed contract, then
  validate the input and handle errors properly. Everyone builds this, so we can
  compare submissions fairly.
- **Part B (wide open).** Ship one thing that makes the app better. You decide
  the feature, the routes, the data shape, the UI. There's no list to pick from
  and no answer key - build the thing you find interesting.

## Tests

From `client/`:

```bash
npm ci
npm test
npm run lint
npm run build
```

The tests use Node's built-in test runner and the existing `tsx` dependency.
To exercise a running local app and its database:

```bash
TEST_API_URL=http://127.0.0.1:3000 npm run test:api
```

The HTTP tests create temporary records and delete only those records, including
when a test fails. They never wipe or reseed the database. They require an
explicit loopback URL to prevent accidental use against a hosted app.
GitHub Actions runs both suites, four timezone checks, repeat migrations, lint,
and a production build with an isolated PostgreSQL database.
