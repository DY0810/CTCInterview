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

/**
 * GET /api/restaurants
 * Returns all restaurants.
 */
export async function GET() {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM restaurants ORDER BY created_at DESC, id DESC'
    );
    // Map every row - raw rows don't match the contract (NUMERIC comes back
    // as a string, timestamps as Date objects). See lib/types.ts.
    return NextResponse.json(rows.map(toRestaurant));
  } catch (err) {
    return handleError(err);
  }
}

/**
 * POST /api/restaurants
 * Create a new restaurant.
 *
 * TODO (A3): validate before you insert. Nothing validates anything today, so
 * `rating` happily accepts 6. Decide what valid means for each field and reject
 * bad bodies with a 400 rather than letting them reach the database.
 */
export async function POST(req: Request) {
  try {
    const { name, cuisine, address, rating } = await req.json();

    // $1 placeholders, not interpolation: these values come from the request,
    // and the difference between a parameter and a string concatenation is the
    // difference between a bind and a SQL injection.
    const { rows } = await pool.query(
      'INSERT INTO restaurants (name, cuisine, address, rating) ' +
        'VALUES ($1, $2, $3, $4) RETURNING *',
      [name ?? null, cuisine ?? null, address ?? null, rating ?? null]
    );

    // RETURNING * hands back the whole row - including the database-generated
    // id and created_at - so there's no second SELECT. It still needs mapping:
    // rating arrives as a string and created_at as a Date.
    return NextResponse.json(toRestaurant(rows[0]), { status: 201 });
  } catch (err) {
    return handleError(err);
  }
}
