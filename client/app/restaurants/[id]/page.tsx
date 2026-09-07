import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getRestaurant, getVisits } from '@/lib/apiClient';
import AddVisitForm from './AddVisitForm';

/**
 * One restaurant and everything spent there.
 *
 * A Server Component that reaches its data the same way `curl` does - through
 * lib/apiClient, over HTTP, against `/api`. No pool import, no Server Action.
 */

/** Money for humans. `null` is a visit with no recorded amount, not $0.00. */
function money(amount: number | null): string {
  return amount === null ? '--' : `$${amount.toFixed(2)}`;
}

export default async function RestaurantPage({
  params,
}: {
  params: { id: string };
}) {
  const [restaurant, data] = await Promise.all([
    getRestaurant(params.id),
    getVisits(params.id),
  ]);

  // Both calls 404 on the same condition, so either being null means there is
  // no such restaurant - including `/restaurants/abc`, where the API rejects
  // the id before it ever reaches Postgres. notFound() renders Next's 404 page
  // with a real 404 status, rather than a page about a restaurant that isn't
  // there. Anything else non-ok has already thrown inside the client.
  if (restaurant === null || data === null) notFound();

  const { visits, totalSpent } = data;

  return (
    <div>
      <Link href="/" className="text-sm text-gray-500 hover:underline">
        &larr; All restaurants
      </Link>

      <div className="mt-4 flex items-baseline justify-between">
        <h2 className="text-lg font-medium">{restaurant.name}</h2>
        {restaurant.rating !== null && (
          <span className="text-sm text-gray-500">{restaurant.rating}★</span>
        )}
      </div>
      <div className="mt-1 text-sm text-gray-600">
        {[restaurant.cuisine, restaurant.address].filter(Boolean).join(' · ')}
      </div>

      <div className="mt-6 rounded-lg border border-gray-200 bg-white p-4">
        <div className="text-sm text-gray-500">Total spent</div>
        <div className="text-2xl font-semibold">{money(totalSpent)}</div>
        <div className="mt-1 text-sm text-gray-500">
          across {visits.length} {visits.length === 1 ? 'visit' : 'visits'}
        </div>
      </div>

      <div className="mt-6">
        <AddVisitForm restaurantId={restaurant.id} />
      </div>

      <h3 className="mb-3 mt-8 font-medium">Visits</h3>
      {visits.length === 0 ? (
        <p className="rounded-lg border border-dashed border-gray-300 p-4 text-sm text-gray-500">
          No visits logged yet. Add the first one above.
        </p>
      ) : (
        <ul className="space-y-3">
          {visits.map((visit) => (
            <li
              key={visit.id}
              className="rounded-lg border border-gray-200 bg-white p-4"
            >
              <div className="flex items-baseline justify-between">
                <span className="font-medium">{visit.date}</span>
                <span className="text-sm text-gray-500">
                  {money(visit.amountSpent)}
                </span>
              </div>
              {visit.notes !== null && (
                <div className="mt-1 text-sm text-gray-600">{visit.notes}</div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
