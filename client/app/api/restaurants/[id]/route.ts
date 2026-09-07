import { NextResponse } from 'next/server';
import { pool } from '@/db/pool';
import { handleError, NotFoundError } from '@/lib/errors';
import { toRestaurant } from '@/lib/types';
import { parseId, parseRestaurantBody } from '@/lib/validate';

// This handler reads live data. Next 14 freezes a GET route handler into a
// static response at build time unless something marks it dynamic - and `npm
// run dev` never shows it. Both route files here happen to be safe today only
// because of which other methods they export (Next's check omits PUT), so this
// line is what keeps that from silently changing under a future edit.
export const dynamic = 'force-dynamic';

type Params = { params: { id: string } };

/**
 * The only failure this route reports about a restaurant, whether the id was
 * unusable or simply matched nothing. Both mean the same thing to a caller, and
 * saying so identically avoids leaking which ids exist.
 */
const notFound = () => new NotFoundError('Restaurant not found');

/**
 * GET /api/restaurants/:id
 * Returns a single restaurant, or 404 if it doesn't exist.
 */
export async function GET(_req: Request, { params }: Params) {
  try {
    // Check the id before querying. An id that isn't a positive integer names
    // no row, so the answer is the same 404 as a well-formed id that misses -
    // and it keeps a value like "abc" away from Postgres, which would raise
    // 22P02 (and, before this guard existed, a 500).
    const id = parseId(params.id);
    if (id === null) throw notFound();

    const { rows } = await pool.query(
      'SELECT * FROM restaurants WHERE id = $1',
      [id]
    );

    if (rows.length === 0) throw notFound();

    return NextResponse.json(toRestaurant(rows[0]));
  } catch (err) {
    return handleError(err);
  }
}

/**
 * PUT /api/restaurants/:id
 * Update an existing restaurant, or 404 if it doesn't exist.
 *
 * Full replacement, not a merge: every mutable field is written from the body,
 * so a field the caller omits becomes null rather than keeping its old value.
 * That is what PUT means - PATCH is the verb for partial updates, and the
 * contract only asks for PUT. It also keeps this handler's body handling
 * identical to POST's, so the two can't drift.
 *
 * Because it replaces, `name` is required here exactly as it is on POST:
 * `{"rating": 4}` would otherwise null out a NOT NULL column and come back as
 * a 500 from the constraint instead of a 400 from us.
 */
export async function PUT(req: Request, { params }: Params) {
  try {
    // Id first, body second. A bad id means the resource doesn't exist, and the
    // contents of a request against a resource that doesn't exist never matter -
    // so `PUT /api/restaurants/abc` is a 404 whatever its body says.
    const id = parseId(params.id);
    if (id === null) throw notFound();

    const { name, cuisine, address, rating } = parseRestaurantBody(
      await req.json()
    );

    const { rows } = await pool.query(
      'UPDATE restaurants SET name = $1, cuisine = $2, address = $3, rating = $4 ' +
        'WHERE id = $5 RETURNING *',
      [name, cuisine, address, rating, id]
    );

    // No row matched the id, so there was nothing to update. Testing `rows`
    // rather than `rowCount` also guards the `rows[0]` dereference below, and
    // matches how the GET handler above answers the same question.
    if (rows.length === 0) throw notFound();

    return NextResponse.json(toRestaurant(rows[0]));
  } catch (err) {
    return handleError(err);
  }
}

/**
 * DELETE /api/restaurants/:id
 * Delete a restaurant. 204 on success, 404 if it doesn't exist.
 */
export async function DELETE(_req: Request, { params }: Params) {
  try {
    const id = parseId(params.id);
    if (id === null) throw notFound();

    // Deliberate, and worth saying out loud: the migration declares
    // visits."restaurantId" ... ON DELETE CASCADE, so this also erases every
    // visit for the restaurant - the app's only record of money spent. I'd
    // normally argue for a soft delete or a 409 when visits exist, but the
    // Part A contract allows only 204 and 404 on this route, so neither is
    // available. The contract made the call, not an oversight. See WriteUp.md.
    const { rowCount } = await pool.query(
      'DELETE FROM restaurants WHERE id = $1',
      [id]
    );

    if (rowCount === 0) throw notFound();

    // A 204 must carry no body. NextResponse.json() always writes one, and the
    // Response constructor rejects a body on a 204 by throwing a TypeError -
    // which the catch below would turn into a 500. Construct it directly.
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return handleError(err);
  }
}
