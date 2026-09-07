import { NextResponse } from 'next/server';
import { pool } from '@/db/pool';
import { handleError, NotFoundError } from '@/lib/errors';
import { toVisit, type VisitsResponse } from '@/lib/types';
import { parseId, parseVisitBody } from '@/lib/validate';

// Keep database reads live in production as well as development.
export const dynamic = 'force-dynamic';

type Params = { params: { id: string } };

/**
 * Unusable and missing restaurant IDs use the same contract response.
 */
const notFound = () => new NotFoundError('Restaurant not found');

/**
 * The restaurant id from the URL, or a 404.
 *
 * Check the parent before reading a POST body, preserving the existing 404
 * precedence. The INSERT rechecks and locks the parent before writing.
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
    const id = parseId(params.id);
    if (id === null) throw notFound();

    // One statement sees one snapshot: the parent, visits and total cannot
    // disagree if a write commits during the request. An empty parent has one
    // joined row with a null visit id; a missing parent has no rows at all.
    const { rows } = await pool.query(
      'SELECT v.*, COALESCE(SUM(v."amountSpent") OVER (), 0) AS total ' +
        'FROM restaurants r LEFT JOIN visits v ON v."restaurantId" = r.id ' +
        'WHERE r.id = $1 ORDER BY v.date DESC, v.id DESC',
      [id]
    );
    if (rows.length === 0) throw notFound();

    const payload: VisitsResponse = {
      visits: rows.filter((row) => row.id !== null).map(toVisit),
      totalSpent: Number(rows[0].total),
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
        'SELECT parent.id, $2, $3, $4 FROM ' +
        '(SELECT id FROM restaurants WHERE id = $1 FOR KEY SHARE) parent RETURNING *',
      [id, date, amountSpent, notes]
    );
    // Deleted since the first check: no insert. Otherwise the row lock keeps
    // the parent from disappearing until this statement has finished.
    if (rows.length === 0) throw notFound();

    return NextResponse.json(toVisit(rows[0]), { status: 201 });
  } catch (err) {
    return handleError(err);
  }
}
