/**
 * The client side of the API: helpers the frontend uses to call the endpoints.
 *
 * Don't confuse this with `app/api/`, which is the other side of the same
 * boundary - the route handlers that *implement* those endpoints. This file
 * only ever talks to them over HTTP.
 *
 * The shapes these helpers return live in `lib/types.ts`, shared with the
 * handlers that produce them.
 */
import type { Restaurant, VisitsResponse } from './types';

// We read a base URL from the environment because Server Components fetch on
// the server, where relative URLs don't resolve - so we need an absolute origin.
// It's the same app on the same port, so this is normally just localhost:3000.
export const API_URL =
  process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

/**
 * GET a JSON body from our own API.
 *
 * Two things every caller needs and the original helpers did neither of:
 *
 *   - A non-ok response is not data. `return res.json()` on a 500 hands the
 *     page an error *object*, which is why the home page failed with
 *     "restaurants.map is not a function" - a message about the page, thirty
 *     lines away from the query that actually broke.
 *   - A 404 is an answer, not a failure, so it comes back as `null` and the
 *     caller decides how to render "no such restaurant". Throwing for it would
 *     make a mistyped URL look like an outage.
 */
async function getJson<T>(path: string): Promise<T | null> {
  const res = await fetch(`${API_URL}${path}`, { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${path} responded ${res.status}`);
  return res.json() as Promise<T>;
}

/** Fetch every restaurant from the API. */
export async function getRestaurants(): Promise<Restaurant[]> {
  const res = await fetch(`${API_URL}/api/restaurants`, { cache: 'no-store' });
  // Not getJson: a collection route has no 404 to interpret, so anything
  // non-ok here is a broken call rather than an empty shelf.
  if (!res.ok) {
    throw new Error(`GET /api/restaurants responded ${res.status}`);
  }
  return res.json();
}

/** Fetch a single restaurant, or null if there is no such restaurant. */
export function getRestaurant(
  id: number | string
): Promise<Restaurant | null> {
  return getJson<Restaurant>(`/api/restaurants/${encodeURIComponent(String(id))}`);
}

/**
 * Fetch a restaurant's visits and total spend, or null if there is no such
 * restaurant. Null for exactly the same reason as getRestaurant: the visits
 * route 404s on the parent, not on an empty list. A restaurant nobody has
 * visited answers 200 with `{ visits: [], totalSpent: 0 }`.
 */
export function getVisits(
  id: number | string
): Promise<VisitsResponse | null> {
  return getJson<VisitsResponse>(`/api/restaurants/${encodeURIComponent(String(id))}/visits`);
}
