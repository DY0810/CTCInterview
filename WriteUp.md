# Write-up

## 1. What did you build for Part B, and why that?

Logging visits: `GET` and `POST /api/restaurants/:id/visits`, plus a
`/restaurants/[id]` page with the visit list, the total, and a form.

The app is named for tracking what Brennen spends eating out, and the `visits`
table already existed — seeded, indexed, with an `amountSpent` column — but no
route or UI touched it. The one column that records money was unreachable, so
the app could not do the thing it is named after. I didn't invent that gap, and
anything else would have been decoration on top of it.

## 2. What did you decide, and what did you rule out?

`GET .../visits` returns `{visits, totalSpent}` rather than a bare array: the
total needs somewhere to live, and sending it means no client re-derives it —
Postgres sums `NUMERIC` exactly, JavaScript turns `10.10 + 20.20` into
`30.299999999999997`.

Amounts with over two decimals are rejected, not rounded: `NUMERIC(10,2)` stores
`12.999` as `13.00`, so the `201` would return a number nobody sent. Future
dates are allowed; the server can't know the caller's "today". Parent before
body on `POST`, id before body on `:id` routes. The A1 `createdAt` fix went in
the mapper, not a per-query alias, so it covers every query written after it.
Ruled out: a schema library, and rejecting unknown fields — they're ignored, so
a typo'd field is accepted silently.

Least sure: I kept `ON DELETE CASCADE`, so deleting a restaurant erases its
spend history. A soft delete or a `409` is better here, but Part A permits only
`204` and `404`. The contract decided it; I'd push back in a real codebase.

## 3. Where did you cut corners?

Lists are still unpaginated and there is no visit editing or deletion.
Unknown fields are ignored; only explicitly allowed fields are written.

The follow-up adds repeatable tests, reads visits and their total in one database
statement, and locks the parent during visit insertion. This closes the two
concurrent-write gaps in the first version. There are no new dependencies.

## 4. What should we look at first?

The A1 bug, in `client/app/api/restaurants/route.ts` and `client/lib/types.ts`.
It has two halves and the second survives a naive fix: the `ORDER BY` named a
column that doesn't exist, and `toRestaurant()` read `row.createdAt` where `pg`
returns `created_at` — so fixing only the query gives a green `200` containing
`"createdAt": "undefined"`. Then `lib/validate.ts`, `lib/errors.ts`, and the
visits route.

---

## Part B: routes

| Method and path                     | What it does                                                            | Success                    | Errors                                                                     |
| ----------------------------------- | ----------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------- |
| `GET /api/restaurants/:id/visits`   | Every visit to that restaurant, newest first, plus what they add up to   | `200` + `VisitsResponse`   | `404` if the restaurant doesn't exist or `:id` isn't a positive integer     |
| `POST /api/restaurants/:id/visits`  | Log a visit against that restaurant                                     | `201` + the created visit  | `400` on an invalid body or malformed JSON; `404` if the restaurant is gone |

Ordering is `date DESC, id DESC` — the `id` tiebreak is not decoration, without
it two visits on the same day come back in whatever order the planner picks and
the list reshuffles between refreshes.

`totalSpent` is always a number, never `null` — `SUM` over zero rows is
`COALESCE`d to `0`, and it's `Number()`ed because `pg` returns `NUMERIC` as a
string.

The visits query now uses `LEFT JOIN` and `SUM(...) OVER ()`, so the restaurant,
visit rows and total come from one database snapshot. A restaurant with no visits
still returns an empty array and zero; a missing restaurant returns 404.
The insert rechecks its parent with `FOR KEY SHARE` inside the INSERT statement.
A deletion after the initial existence check either completes first, producing
404 without a write, or waits for the insertion to finish.

**`GET /api/restaurants/1/visits`**

```jsonc
// 200 response
{
  "visits": [
    {
      "id": 1,
      "restaurantId": 1,
      "date": "2026-01-12",
      "amountSpent": 42.5,
      "notes": "Burger night with the crew.",
      "createdAt": "2026-09-07T07:51:54.984Z"
    }
  ],
  "totalSpent": 42.5
}

// 200 response, restaurant 3 — nobody has visited it
{ "visits": [], "totalSpent": 0 }
```

**`POST /api/restaurants/1/visits`**

```jsonc
// request — `date` required ("YYYY-MM-DD"), `amountSpent` and `notes` optional.
// `restaurantId` is deliberately NOT read from the body; the URL is the only copy.
{ "date": "2026-04-01", "amountSpent": 25.50, "notes": "Lunch" }

// 201 response
{
  "id": 4,
  "restaurantId": 1,
  "date": "2026-04-01",
  "amountSpent": 25.5,
  "notes": "Lunch",
  "createdAt": "2026-09-07T07:54:35.035Z"
}

// 400 response — every problem at once, not one per round trip
{
  "error": "Invalid request body",
  "details": [
    "date must be a real calendar date in YYYY-MM-DD form",
    "amountSpent must not be negative",
    "notes must be a string or null"
  ]
}
```

One page came with it: `/restaurants/[id]` (Server Component, plus one client
component for the form). It reaches its data through `lib/apiClient.ts` over
HTTP against `/api`, same as `curl` — no pool import, no Server Action.

## Schema changes

One new file: `client/db/migrations/002_visit_constraints.sql`. It adds a
non-negative `CHECK` on `visits."amountSpent"`:

```sql
ALTER TABLE visits DROP CONSTRAINT IF EXISTS visits_amount_nonneg;

ALTER TABLE visits ADD CONSTRAINT visits_amount_nonneg
  CHECK ("amountSpent" IS NULL OR "amountSpent" >= 0);
```

Two things worth saying about it:

- **A new file, not an edit to 001.** The runner has no ledger and 001 is
  `CREATE TABLE IF NOT EXISTS`, so an edit there does nothing on a database that
  already has the tables — while `npm run migrate` still prints
  `Applied N migration(s).` as if it worked.
- **Written re-runnable.** The runner replays every file on every run, and
  Postgres has no `ADD CONSTRAINT IF NOT EXISTS`, so it drops first. The two
  statements go in one `pool.query`, which runs as a single implicit
  transaction, so the constraint is never actually absent to another session.

`lib/validate.ts` already rejects a negative amount with a `400` before any
insert. The constraint is the guard that survives a second writer — the seed
script, a `psql` session, whatever calls this database next.

**No extra schema setup beyond `./setup.sh`.** No new dependencies. The follow-up
adds `npm test` and `npm run test:api` scripts.

## How I verified this

### Repeatable checks

From `client/`:

```bash
npm ci
npm test
npm run lint
npm run build
TEST_API_URL=http://127.0.0.1:3000 npm run test:api
```

The last command needs a running local app. `tests/core.test.ts` covers mapping,
strict timestamps, IDs, input validation, exact cents, dates, Unicode limits,
safe errors and controlled write races. `tests/api.test.ts` checks actual HTTP
responses and persistence against PostgreSQL, including concurrent reads and
writes. It creates temporary restaurants and removes only those IDs and their
visits. It never wipes or reseeds a database, and refuses non-loopback URLs.

GitHub Actions runs the core tests under UTC, America/Los_Angeles, Asia/Tokyo and
Pacific/Kiritimati. It applies migrations twice to a disposable PostgreSQL 16
database, builds the app, then runs the HTTP suite against `next start` with
the server timezone set to Asia/Tokyo. This checks live production reads, not
only development behavior.

The six new correctness tests failed before the follow-up repairs and passed
afterward. The original naming, NUL, oversized-ID, error-lookup and 204 behaviors
are now covered as regressions. The page error screen has a generic message
and a full-page retry; an isolated database outage and recovery were also
checked in the browser.

### Original manual verification

The output below is the original implementation's recorded `curl` sweep, not a
claim that these exact IDs or timestamps recur in the new tests. That sweep
used a freshly rebuilt sample database. **Do not wipe your own database to run
the new tests.**

### Part A — every row of the contract table

```bash
B=http://localhost:3000/api/restaurants
curl -s -o /dev/null -w 'GET list          -> %{http_code}\n' $B
curl -s -o /dev/null -w 'GET one           -> %{http_code}\n' $B/1
curl -s -o /dev/null -w 'GET missing       -> %{http_code}\n' $B/99999
curl -s -o /dev/null -w 'GET abc           -> %{http_code}\n' $B/abc
curl -s -o /dev/null -w 'GET -1            -> %{http_code}\n' $B/-1
curl -s -o /dev/null -w 'GET 1.5           -> %{http_code}\n' $B/1.5
curl -s -o /dev/null -w 'GET 0             -> %{http_code}\n' $B/0
curl -s -o /dev/null -w 'GET 0x10          -> %{http_code}\n' $B/0x10
curl -s -o /dev/null -w 'GET 99999999999   -> %{http_code}\n' $B/99999999999
```

```
GET list          -> 200
GET one           -> 200
GET missing       -> 404
GET abc           -> 404
GET -1            -> 404
GET 1.5           -> 404
GET 0             -> 404
GET 0x10          -> 404
GET 99999999999   -> 404
```

`0x10` and `99999999999` are in there because `Number()` would have accepted
both — `Number('0x10')` is `16`, so `/api/restaurants/0x10` would have quietly
served restaurant 16, and an id past `int4` raises `22003` in Postgres rather
than returning zero rows. `parseId` is a digits-only test with a `MAX_ID` cap
for exactly that reason.

```bash
curl -s $B          # A1: real ISO createdAt, not "undefined"
curl -s $B/1
```

```
[{"id":5,"name":"Green Bowl","cuisine":"Vegetarian","address":"5 Garden Way","rating":3.9,"createdAt":"2026-09-07T07:51:54.984Z"}, ... ,{"id":1,"name":"The Rusty Spoon","cuisine":"American","address":"12 Main St","rating":4.5,"createdAt":"2026-09-07T07:51:54.984Z"}]

{"id":1,"name":"The Rusty Spoon","cuisine":"American","address":"12 Main St","rating":4.5,"createdAt":"2026-09-07T07:51:54.984Z"}
```

Writes, and every way I could think of to send a bad body:

```bash
curl -s -i -X POST $B -H 'Content-Type: application/json' \
  -d '{"name":"Valid Spot","cuisine":"Test","address":"2 Test St","rating":4.5}'
curl -s -i -X POST $B -H 'Content-Type: application/json' -d '{"name":"Out Of Range","rating":6}'
curl -s -i -X POST $B -H 'Content-Type: application/json' -d '{"rating":4}'
curl -s -i -X POST $B -H 'Content-Type: application/json' -d '{"name":123}'
curl -s -i -X POST $B -H 'Content-Type: application/json' -d '[]'
curl -s -i -X POST $B -H 'Content-Type: application/json' -d '{bad json}'
curl -s -i -X POST $B -H 'Content-Type: application/json'          # empty body
```

```
HTTP/1.1 201 Created
{"id":6,"name":"Valid Spot","cuisine":"Test","address":"2 Test St","rating":4.5,"createdAt":"2026-09-07T07:53:59.341Z"}

HTTP/1.1 400 Bad Request
{"error":"Invalid request body","details":["rating must be between 0 and 5"]}

HTTP/1.1 400 Bad Request
{"error":"Invalid request body","details":["name is required"]}

HTTP/1.1 400 Bad Request
{"error":"Invalid request body","details":["name must be a string"]}

HTTP/1.1 400 Bad Request
{"error":"Invalid request body","details":["body must be a JSON object"]}

HTTP/1.1 400 Bad Request
{"error":"Invalid JSON body"}

HTTP/1.1 400 Bad Request
{"error":"Invalid JSON body"}
```

```bash
curl -s -i -X PUT $B/6 -H 'Content-Type: application/json' \
  -d '{"name":"Renamed Spot","cuisine":"Test","address":"2 Test St","rating":3}'
curl -s -i -X PUT $B/6   -H 'Content-Type: application/json' -d '{"name":"x","rating":6}'
curl -s -i -X PUT $B/abc -H 'Content-Type: application/json' -d '{bad json}'   # id wins
curl -s -o /dev/null -w 'PUT missing       -> %{http_code}\n' -X PUT $B/99999 \
  -H 'Content-Type: application/json' -d '{"name":"x"}'
curl -s -o /dev/null -w 'DELETE %{http_code}, body bytes=%{size_download}\n' -X DELETE $B/6
curl -s -o /dev/null -w 'DELETE missing    -> %{http_code}\n' -X DELETE $B/99999
```

```
HTTP/1.1 200 OK
{"id":6,"name":"Renamed Spot","cuisine":"Test","address":"2 Test St","rating":3,"createdAt":"2026-09-07T07:53:59.341Z"}

HTTP/1.1 400 Bad Request
{"error":"Invalid request body","details":["rating must be between 0 and 5"]}

HTTP/1.1 404 Not Found
{"error":"Restaurant not found"}

PUT missing       -> 404
DELETE 204, body bytes=0
DELETE missing    -> 404
```

`body bytes=0` is the check that matters on the `204`: `NextResponse.json()`
always writes a body, the `Response` constructor rejects a body on a `204` by
throwing, and that throw would have surfaced as a `500`.

`PUT /api/restaurants/abc` with deliberately broken JSON returns `404`, not
`400` — the id is checked first, so the body never gets read.

### Part B — visits

```bash
curl -s $B/1/visits
curl -s $B/3/visits            # nobody has visited restaurant 3
curl -s -i $B/99999/visits
curl -s -i $B/abc/visits
```

```
{"visits":[{"id":1,"restaurantId":1,"date":"2026-01-12","amountSpent":42.5,"notes":"Burger night with the crew.","createdAt":"2026-09-07T07:51:54.984Z"}],"totalSpent":42.5}

{"visits":[],"totalSpent":0}

HTTP/1.1 404 Not Found
{"error":"Restaurant not found"}

HTTP/1.1 404 Not Found
{"error":"Restaurant not found"}
```

`totalSpent: 0` and not `null` on restaurant 3 is the `COALESCE`; `42.5` and not
`"42.50"` is the `Number()`. `date` is `"2026-01-12"` with no time and no
timezone — `pg` hands back a `Date` at *local* midnight, so `dateOnly()` reads
the local parts rather than `toISOString()`, which shifts the day east of UTC.

```bash
V=$B/1/visits
curl -s -i -X POST $V -H 'Content-Type: application/json' -d '{"date":"2026-04-01","amountSpent":25.50,"notes":"Lunch"}'
curl -s -i -X POST $V -H 'Content-Type: application/json' -d '{"amountSpent":10}'
curl -s -i -X POST $V -H 'Content-Type: application/json' -d '{"date":"2026-02-30"}'
curl -s -i -X POST $V -H 'Content-Type: application/json' -d '{"date":"2026-04-02","amountSpent":-5}'
curl -s -i -X POST $V -H 'Content-Type: application/json' -d '{"date":"2026-04-02","amountSpent":"10"}'
curl -s -i -X POST $V -H 'Content-Type: application/json' -d '{"date":"2026-04-02","amountSpent":12.999}'
curl -s -i -X POST $V -H 'Content-Type: application/json' -d '{"date":"nope","amountSpent":-1,"notes":123}'
curl -s -i -X POST $V -H 'Content-Type: application/json' -d '{bad json}'
curl -s -i -X POST $V -H 'Content-Type: application/json'                        # empty body
curl -s -i -X POST $B/99999/visits -H 'Content-Type: application/json' -d '{"date":"2026-04-01","amountSpent":10}'
curl -s -i -X POST $V -H 'Content-Type: application/json' -d '{"date":"2099-12-31","amountSpent":1.00,"notes":"future"}'
curl -s -i -X POST $V -H 'Content-Type: application/json' -d '{"date":"2026-04-03"}'
```

```
HTTP/1.1 201 Created
{"id":4,"restaurantId":1,"date":"2026-04-01","amountSpent":25.5,"notes":"Lunch","createdAt":"2026-09-07T07:54:35.035Z"}

HTTP/1.1 400 Bad Request
{"error":"Invalid request body","details":["date is required"]}

HTTP/1.1 400 Bad Request
{"error":"Invalid request body","details":["date must be a real calendar date in YYYY-MM-DD form"]}

HTTP/1.1 400 Bad Request
{"error":"Invalid request body","details":["amountSpent must not be negative"]}

HTTP/1.1 400 Bad Request
{"error":"Invalid request body","details":["amountSpent must be a number"]}

HTTP/1.1 400 Bad Request
{"error":"Invalid request body","details":["amountSpent must have at most 2 decimal places"]}

HTTP/1.1 400 Bad Request
{"error":"Invalid request body","details":["date must be a real calendar date in YYYY-MM-DD form","amountSpent must not be negative","notes must be a string or null"]}

HTTP/1.1 400 Bad Request
{"error":"Invalid JSON body"}

HTTP/1.1 400 Bad Request
{"error":"Invalid JSON body"}

HTTP/1.1 404 Not Found
{"error":"Restaurant not found"}

HTTP/1.1 201 Created
{"id":5,"restaurantId":1,"date":"2099-12-31","amountSpent":1,"notes":"future","createdAt":"2026-09-07T07:54:35.126Z"}

HTTP/1.1 201 Created
{"id":6,"restaurantId":1,"date":"2026-04-03","amountSpent":null,"notes":null,"createdAt":"2026-09-07T07:54:35.135Z"}
```

`2026-02-30` matters because it passes a shape check: `new Date('2026-02-30')`
rolls silently forward to March 2nd, so the stored date would be a day the
caller never sent. `"10"` as a string is a `400` on purpose — JSON has a number
type, so a caller sending a string means something else. `12.999` is the
reject-don't-round decision. A future date and an absent `amountSpent` are both
accepted, deliberately.

The total after those three inserts, checked against the arithmetic
(42.50 + 25.50 + 1.00, with one visit carrying no amount):

```bash
curl -s $B/1/visits
```

```
{"visits":[ ... 4 visits ... ],"totalSpent":69}
```

The `CHECK` from migration 002, hit directly rather than through the API:

```bash
docker compose exec -T db psql -U postgres -d feeding_brennen \
  -c "INSERT INTO visits (\"restaurantId\", date, \"amountSpent\") VALUES (1, '2026-05-01', -1);"
```

```
ERROR:  new row for relation "visits" violates check constraint "visits_amount_nonneg"
```

### Pages

```bash
for p in / /restaurants/1 /restaurants/3 /restaurants/abc /restaurants/99999; do
  printf '%-22s -> %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3000$p)"
done
```

```
/                      -> 200
/restaurants/1         -> 200
/restaurants/3         -> 200
/restaurants/abc       -> 404
/restaurants/99999     -> 404
```

`/restaurants/1` renders (tags stripped):

```
The Rusty Spoon 4.5★ American · 12 Main St
Total spent $69.00 across 4 visits
Log a visit  Date  Amount  Notes  [Add visit]
Visits
2099-12-31 $1.00 future
2026-04-03 --
2026-04-01 $25.50 Lunch
2026-01-12 $42.50 Burger night with the crew.
```

`--` rather than `$0.00` for the visit with no amount: an unrecorded bill isn't
a free meal. The add-visit form was also driven in a real browser — submit,
`router.refresh()`, new row appears and the total goes up.

### Build and lint

```bash
cd client && npm run lint && npm run build
```

(Run against a copy of `client/` so it wouldn't fight the dev server over
`.next`; the tree is otherwise identical.)

```
✔ No ESLint warnings or errors

Route (app)                              Size     First Load JS
┌ ƒ /                                    175 B          96.1 kB
├ ○ /_not-found                          872 B          88.1 kB
├ ○ /api/health                          0 B                0 B
├ ƒ /api/restaurants                     0 B                0 B
├ ƒ /api/restaurants/[id]                0 B                0 B
├ ƒ /api/restaurants/[id]/visits         0 B                0 B
└ ƒ /restaurants/[id]                    1.14 kB          97 kB
```

This is the check `npm run dev` cannot give you. Next 14 freezes a `GET` route
handler into a build-time constant unless something marks it dynamic, and its
own `hasNonStaticMethods` list omits `PUT` — so a route file's protection
depends on which other methods it happens to export. Every `/api` route with a
database behind it is `ƒ`. `/api/health` is `○`, correctly: it returns a
constant and never touches the database.

### Cleanup

```bash
docker compose exec -T db psql -U postgres -d feeding_brennen \
  -c "SELECT (SELECT count(*) FROM restaurants) AS restaurants, (SELECT count(*) FROM visits) AS visits;"
```

```
 restaurants | visits
-------------+--------
           5 |      3
```

Back to the 5 seeded restaurants and 3 seeded visits, ids and sequences
included.

## Known issues / what I'd do next

The follow-up closes the missing-test, inconsistent-total, parent-deletion,
page-recovery and UTF-16 length issues recorded in the first version. It also
rejects invalid database timestamps and keeps decoded IDs within one API URL
segment.

Remaining tradeoffs:

1. **No pagination** on restaurant or visit lists.
2. **Unknown fields are ignored.** Only named, validated fields are stored.
3. **Text limits count Unicode code points, not displayed symbols.** A simple
   emoji counts once; a combined symbol can still contain multiple code points.
4. **`ON DELETE CASCADE`** remains as described in question 2.

Deliberately not built, rather than run out of time: `DELETE /api/visits/:id`,
editing a visit, a currency field, and a spend total on the home page.

Two more that are Next's, not this application's — worth knowing they exist so
nobody spends an afternoon on them:

- **`TRACE` on any route handler returns `500`.** It hits the untouched
  `/api/health` too, so my code didn't introduce it. `PATCH` on a route that
  doesn't export it is fine — that's a correct `405`.
- **A malformed `Next-Router-State-Tree` request header returns `500` on page
  routes.** `/` and `/restaurants/1` both do it; the `/api` routes are unaffected.
