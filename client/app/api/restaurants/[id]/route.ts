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
 * Update an existing restaurant.
 *
 * TODO (A2): implement. Update the row matching :id and return the updated
 * record (or 404 if it doesn't exist). Validate the body the same way POST does.
 */
export async function PUT(_req: Request, _ctx: Params) {
  return NextResponse.json({ error: 'Not implemented' }, { status: 501 });
}

/**
 * DELETE /api/restaurants/:id
 * Delete a restaurant.
 *
 * TODO (A2): implement. Delete the row matching :id and return 204 (or 404
 * if it doesn't exist).
 *
 * Worth noticing: the migration already made a call about what happens to that
 * restaurant's visits. Go read it. If you disagree with it, say so in your
 * write-up.
 */
export async function DELETE(_req: Request, _ctx: Params) {
  return NextResponse.json({ error: 'Not implemented' }, { status: 501 });
}
