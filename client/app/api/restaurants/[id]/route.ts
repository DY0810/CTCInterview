import { NextResponse } from 'next/server';
import { pool } from '@/db/pool';
import { handleError } from '@/lib/errors';
import { toRestaurant } from '@/lib/types';

// This handler reads live data. Next 14 freezes a GET route handler into a
// static response at build time unless something marks it dynamic - and `npm
// run dev` never shows it. Both route files here happen to be safe today only
// because of which other methods they export (Next's check omits PUT), so this
// line is what keeps that from silently changing under a future edit.
export const dynamic = 'force-dynamic';

type Params = { params: { id: string } };

/**
 * GET /api/restaurants/:id
 * Returns a single restaurant, or 404 if it doesn't exist.
 */
export async function GET(_req: Request, { params }: Params) {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM restaurants WHERE id = $1',
      [params.id]
    );

    if (rows.length === 0) {
      return NextResponse.json({ error: 'Restaurant not found' }, { status: 404 });
    }

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
 * TODO (A3): validate the body the same way POST does.
 */
export async function PUT(req: Request, { params }: Params) {
  try {
    const { name, cuisine, address, rating } = await req.json();

    const { rows } = await pool.query(
      'UPDATE restaurants SET name = $1, cuisine = $2, address = $3, rating = $4 ' +
        'WHERE id = $5 RETURNING *',
      [name ?? null, cuisine ?? null, address ?? null, rating ?? null, params.id]
    );

    // No row matched the id, so there was nothing to update. Testing `rows`
    // rather than `rowCount` also guards the `rows[0]` dereference below, and
    // matches how the GET handler above answers the same question.
    if (rows.length === 0) {
      return NextResponse.json({ error: 'Restaurant not found' }, { status: 404 });
    }

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
    // Deliberate, and worth saying out loud: the migration declares
    // visits."restaurantId" ... ON DELETE CASCADE, so this also erases every
    // visit for the restaurant - the app's only record of money spent. I'd
    // normally argue for a soft delete or a 409 when visits exist, but the
    // Part A contract allows only 204 and 404 on this route, so neither is
    // available. The contract made the call, not an oversight. See WriteUp.md.
    const { rowCount } = await pool.query(
      'DELETE FROM restaurants WHERE id = $1',
      [params.id]
    );

    if (rowCount === 0) {
      return NextResponse.json({ error: 'Restaurant not found' }, { status: 404 });
    }

    // A 204 must carry no body. NextResponse.json() always writes one, and the
    // Response constructor rejects a body on a 204 by throwing a TypeError -
    // which the catch below would turn into a 500. Construct it directly.
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return handleError(err);
  }
}
