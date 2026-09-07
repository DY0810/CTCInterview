import { NextResponse } from 'next/server';
import { pool } from '@/db/pool';
import { handleError, NotFoundError } from '@/lib/errors';
import { toVisit, type VisitsResponse } from '@/lib/types';
import { parseId, parseVisitBody } from '@/lib/validate';

// These handlers read live data. Next 14 freezes a GET route handler into a
// static response at build time unless something marks it dynamic, and `npm run
// dev` never shows it - the two restaurant route files are only safe today
// because of which other methods they happen to export. This file exports POST,
// so it would be safe by the same accident; the line is here so it stays safe
// when someone edits the method mix.
export const dynamic = 'force-dynamic';

type Params = { params: { id: string } };

/**
 * The only failure either handler reports about the restaurant in the URL,
 * whether the id was unusable or simply matched nothing. Same wording as the
 * restaurant routes, and it avoids leaking which ids exist.
 */
const notFound = () => new NotFoundError('Restaurant not found');

/**
 * The restaurant id from the URL, or a 404.
 *
 * Both handlers hang off a restaurant that has to exist, so both check it the
 * same way and in the same place. For POST that check is worth the round trip
 * rather than letting the insert fail: the foreign key raises 23503, which
 * `handleError` maps to a 400 - technically true, but it tells the caller their
 * body was wrong when the URL was. The FK is still the backstop if the
 * restaurant is deleted between this SELECT and the INSERT.
 */
async function requireRestaurantId(raw: string): Promise<number> {
  const id = parseId(raw);
  if (id === null) throw notFound();

  const { rows } = await pool.query(
    'SELECT 1 FROM restaurants WHERE id = $1',
    [id]
  );
  if (rows.length === 0) throw notFound();

  return id;
}

/**
 * GET /api/restaurants/:id/visits
 * Every visit to that restaurant, newest first, plus what they add up to.
 * 404 if the restaurant doesn't exist or the id isn't a positive integer.
 */
export async function GET(_req: Request, { params }: Params) {
  try {
    const id = await requireRestaurantId(params.id);

    const [{ rows }, { rows: totals }] = await Promise.all([
      // `id DESC` is not decoration: two visits on the same day are otherwise
      // returned in whatever order the planner feels like, so the list would
      // reshuffle between refreshes.
      pool.query(
        'SELECT * FROM visits WHERE "restaurantId" = $1 ORDER BY date DESC, id DESC',
        [id]
      ),
      // COALESCE because SUM over zero rows is null, not 0 - a restaurant
      // nobody has visited has spent nothing, and `"totalSpent": null` would
      // make every caller write the same defaulting code.
      pool.query(
        'SELECT COALESCE(SUM("amountSpent"), 0) AS total FROM visits WHERE "restaurantId" = $1',
        [id]
      ),
    ]);

    const payload: VisitsResponse = {
      // Raw rows don't match the contract: `date` arrives as a Date built at
      // local midnight and `amountSpent` as a string. See lib/types.ts.
      visits: rows.map(toVisit),
      // Number() because pg hands back NUMERIC - SUM included - as a string.
      // Without it `totalSpent` ships as "162.25" and the next thing that adds
      // to it concatenates instead.
      totalSpent: Number(totals[0].total),
    };

    return NextResponse.json(payload);
  } catch (err) {
    return handleError(err);
  }
}

/**
 * POST /api/restaurants/:id/visits
 * Log a visit. 201 with the created visit, 400 on a bad body, 404 if the
 * restaurant doesn't exist.
 */
export async function POST(req: Request, { params }: Params) {
  try {
    // Restaurant first, body second: this posts *into* a collection that has to
    // exist, and there is nothing to validate a body against when it doesn't.
    const id = await requireRestaurantId(params.id);

    const { date, amountSpent, notes } = parseVisitBody(await req.json());

    // `date` goes as the validated "YYYY-MM-DD" string, never as a JS Date:
    // Postgres parses it as a calendar date with no timezone involved, while a
    // Date would be serialised as an instant and can land on the day either
    // side. $1 placeholders, not interpolation, for every request value.
    const { rows } = await pool.query(
      'INSERT INTO visits ("restaurantId", date, "amountSpent", notes) ' +
        'VALUES ($1, $2, $3, $4) RETURNING *',
      [id, date, amountSpent, notes]
    );

    return NextResponse.json(toVisit(rows[0]), { status: 201 });
  } catch (err) {
    return handleError(err);
  }
}
