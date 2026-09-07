'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * The one interactive piece on the page, so the one component that ships to the
 * browser. Everything around it stays a Server Component.
 *
 * It POSTs to the same `/api` route `curl` does - no Server Action, no database
 * access - and then asks the server to re-render rather than splicing the new
 * visit into a local copy of the list. The list and the total then always come
 * from the same place, so they cannot disagree about what was just saved.
 */
export default function AddVisitForm({
  restaurantId,
}: {
  restaurantId: number;
}) {
  const router = useRouter();
  const [date, setDate] = useState('');
  const [amountSpent, setAmountSpent] = useState('');
  const [notes, setNotes] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setProblems([]);

    try {
      // A relative URL because this runs in the browser: same origin, same
      // route handler the Server Components call.
      const res = await fetch(`/api/restaurants/${restaurantId}/visits`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date,
          // An empty input is "no amount", i.e. null - not the empty string.
          // The API rejects a string amount on purpose, and `<input>` values
          // are always strings, so the conversion has to happen here.
          amountSpent: amountSpent === '' ? null : Number(amountSpent),
          notes: notes === '' ? null : notes,
        }),
      });

      if (!res.ok) {
        // The API collects every problem into `details`; show them all rather
        // than making someone resubmit once per field.
        const body = await res.json().catch(() => null);
        setProblems(
          body?.details ?? [body?.error ?? `Request failed (${res.status})`]
        );
        return;
      }

      setDate('');
      setAmountSpent('');
      setNotes('');
      router.refresh();
    } catch {
      // A network failure never reaches the `!res.ok` branch above.
      setProblems(['Could not reach the server. Is it still running?']);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-lg border border-gray-200 bg-white p-4"
    >
      <h3 className="mb-3 font-medium">Log a visit</h3>

      <div className="flex flex-wrap gap-3">
        <label className="text-sm text-gray-600">
          <span className="mb-1 block">Date</span>
          {/* type="date" gives a picker and a YYYY-MM-DD value for free, which
              is exactly the format the API validates. No date library. */}
          <input
            type="date"
            required
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="rounded border border-gray-300 px-2 py-1 text-gray-900"
          />
        </label>

        <label className="text-sm text-gray-600">
          <span className="mb-1 block">Amount</span>
          <input
            type="number"
            min="0"
            step="0.01"
            placeholder="0.00"
            value={amountSpent}
            onChange={(e) => setAmountSpent(e.target.value)}
            className="w-28 rounded border border-gray-300 px-2 py-1 text-gray-900"
          />
        </label>

        <label className="flex-1 text-sm text-gray-600">
          <span className="mb-1 block">Notes</span>
          <input
            type="text"
            placeholder="What did you eat?"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="w-full rounded border border-gray-300 px-2 py-1 text-gray-900"
          />
        </label>
      </div>

      {problems.length > 0 && (
        <ul
          role="alert"
          className="mt-3 list-inside list-disc text-sm text-red-600"
        >
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}

      <button
        type="submit"
        disabled={saving}
        className="mt-3 rounded bg-gray-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
      >
        {saving ? 'Saving...' : 'Add visit'}
      </button>
    </form>
  );
}
