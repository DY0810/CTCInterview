import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Restaurant, Visit, VisitsResponse } from '../lib/types';

const urlError =
  'TEST_API_URL must explicitly name an http:// loopback origin ' +
  '(127.0.0.1, localhost, or [::1]), without credentials, path, query, or fragment';
let base: URL;
try {
  base = new URL(process.env.TEST_API_URL ?? '');
} catch {
  throw new Error(urlError);
}
assert.ok(
  base.protocol === 'http:' &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) &&
    base.pathname === '/' &&
    !base.username && !base.password && !base.search && !base.hash,
  urlError
);

const restaurants = '/api/restaurants';
const ownedIds = new Set<number>();
const uniqueName = () => `http-contract-${randomUUID()}`;
const forgedTimestamp = '2001-01-01T00:00:00.000Z';

async function request<T = unknown>(
  method: string,
  path: string,
  expectedStatus: number,
  body?: BodyInit
): Promise<T> {
  const init: RequestInit & { duplex?: 'half' } = {
    method,
    body,
    headers: { 'Content-Type': 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  };
  if (body instanceof ReadableStream) init.duplex = 'half';
  const response = await fetch(new URL(path, base), init);
  const text = await response.text();
  let data: unknown;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`${method} ${path}: response was not JSON`);
    }
  }

  // Track successful inserts before assertions, including unexpectedly accepted
  // invalid bodies. Cleanup never discovers IDs from the collection or seeds.
  if (
    method === 'POST' && path === restaurants && response.ok &&
    data !== null && typeof data === 'object' && 'id' in data &&
    typeof data.id === 'number' && Number.isInteger(data.id) &&
    data.id > 0 && data.id <= 2147483647
  ) {
    ownedIds.add(data.id);
  }

  assert.equal(response.status, expectedStatus, `${method} ${path}`);
  if (expectedStatus === 204) {
    assert.equal(text, '', '204 responses must have no body');
  } else {
    assert.match(response.headers.get('content-type') ?? '', /application\/json/i);
    assert.notEqual(data, undefined, 'JSON responses must have a body');
  }
  if (expectedStatus >= 400) {
    assert.ok(data !== null && typeof data === 'object' && !Array.isArray(data));
    const error = data as Record<string, unknown>;
    assert.equal(typeof error.error, 'string');
    assert.ok(error.error);
    assert.ok(Object.keys(error).every((key) => key === 'error' || key === 'details'));
    if (error.details !== undefined) {
      assert.ok(Array.isArray(error.details));
      assert.ok(error.details.every((detail) => typeof detail === 'string'));
    }
  }
  return data as T;
}

function assertTimestamp(value: string) {
  assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(new Date(value).toISOString(), value);
}

function assertRestaurant(value: Restaurant) {
  assert.deepEqual(Object.keys(value).sort(), [
    'address', 'createdAt', 'cuisine', 'id', 'name', 'rating',
  ]);
  assert.ok(Number.isInteger(value.id) && value.id > 0);
  assert.equal(typeof value.name, 'string');
  assert.ok(value.cuisine === null || typeof value.cuisine === 'string');
  assert.ok(value.address === null || typeof value.address === 'string');
  assert.ok(value.rating === null || (
    typeof value.rating === 'number' && value.rating >= 0 && value.rating <= 5
  ));
  assertTimestamp(value.createdAt);
}

function assertVisit(value: Visit, parentId: number) {
  assert.deepEqual(Object.keys(value).sort(), [
    'amountSpent', 'createdAt', 'date', 'id', 'notes', 'restaurantId',
  ]);
  assert.ok(Number.isInteger(value.id) && value.id > 0);
  assert.equal(value.restaurantId, parentId);
  assert.match(value.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(value.amountSpent === null || (
    typeof value.amountSpent === 'number' && Number.isFinite(value.amountSpent) &&
    value.amountSpent >= 0
  ));
  assert.ok(value.notes === null || typeof value.notes === 'string');
  assertTimestamp(value.createdAt);
}

async function createRestaurant(fields: Record<string, unknown> = {}) {
  const value = await request<Restaurant>('POST', restaurants, 201,
    JSON.stringify({ name: uniqueName(), ...fields }));
  assertRestaurant(value);
  return value;
}

async function createVisit(parentId: number, fields: Record<string, unknown> = {}) {
  assert.ok(ownedIds.has(parentId), 'Visits must belong to an owned restaurant');
  const value = await request<Visit>('POST', `${restaurants}/${parentId}/visits`, 201,
    JSON.stringify({ date: '2026-09-07', notes: uniqueName(), ...fields }));
  assertVisit(value, parentId);
  return value;
}

function assertVisits(value: VisitsResponse, parentId: number) {
  assert.deepEqual(Object.keys(value).sort(), ['totalSpent', 'visits']);
  assert.ok(Array.isArray(value.visits));
  assert.equal(typeof value.totalSpent, 'number');
  for (const visit of value.visits) assertVisit(visit, parentId);
  assert.equal(new Set(value.visits.map((visit) => visit.id)).size, value.visits.length);
  assert.deepEqual(value.visits, [...value.visits].sort(
    (a, b) => b.date.localeCompare(a.date) || b.id - a.id
  ));
  const cents = value.visits.reduce(
    (sum, visit) => sum + Math.round((visit.amountSpent ?? 0) * 100), 0
  );
  assert.equal(value.totalSpent, cents / 100, 'List and total must share one snapshot');
}

// Wait for every worker even when one fails, so cleanup cannot race late writes.
async function settle(work: Promise<unknown>[]) {
  const results = await Promise.allSettled(work);
  const failures = results.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  );
  if (failures.length) {
    throw new AggregateError(failures.map((result) => result.reason), 'HTTP checks failed');
  }
}

test('HTTP API contract', { timeout: 240_000 }, async (t) => {
  t.after(async () => {
    // Deleting only our parents also removes their visits through ON DELETE CASCADE.
    await settle([...ownedIds].map(async (id) => {
      const response = await fetch(new URL(`${restaurants}/${id}`, base), {
        method: 'DELETE',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
      const text = await response.text();
      assert.ok(
        response.status === 204 || response.status === 404,
        `Cleanup of owned restaurant ${id} returned ${response.status}`
      );
      if (response.status === 204) assert.equal(text, '');
    }));
  });

  await t.test('Part A statuses, mapping, replacement, and live GETs', async () => {
    assert.ok(Array.isArray(await request('GET', restaurants, 200)));
    const name = uniqueName();
    const created = await createRestaurant({
      name: `  ${name}  `, cuisine: '  Test  ', address: '  Test address  ', rating: 4.5,
    });
    assert.deepEqual(created, {
      id: created.id, name, cuisine: 'Test', address: 'Test address', rating: 4.5,
      createdAt: created.createdAt,
    });
    const path = `${restaurants}/${created.id}`;
    assert.deepEqual(await request('GET', path, 200), created);
    let list = await request<Restaurant[]>('GET', restaurants, 200);
    assert.deepEqual(list.find((row) => row.id === created.id), created);

    const replacement = { ...created, name: uniqueName(), cuisine: null, address: null, rating: null };
    assert.deepEqual(
      await request('PUT', path, 200, JSON.stringify({ name: replacement.name })),
      replacement
    );
    assert.deepEqual(await request('GET', path, 200), replacement);
    list = await request<Restaurant[]>('GET', restaurants, 200);
    assert.deepEqual(list.find((row) => row.id === created.id), replacement);

    await request('DELETE', path, 204);
    await request('DELETE', path, 404);
    await request('GET', path, 404);
    list = await request<Restaurant[]>('GET', restaurants, 200);
    assert.ok(!list.some((row) => row.id === created.id));
  });

  await t.test('rating endpoints and unknown restaurant fields cannot be assigned', async () => {
    const other = await createRestaurant();
    for (const rating of [0, 5]) {
      const created = await createRestaurant({
        rating, cuisine: '  ', address: null,
        id: other.id, created_at: forgedTimestamp, createdAt: forgedTimestamp,
        unexpected: 'ignored\u0000field',
      });
      assert.equal(created.rating, rating);
      assert.equal(created.cuisine, null);
      assert.equal(created.address, null);
      assert.notEqual(created.id, other.id);
      assert.notEqual(created.createdAt, forgedTimestamp);
      const path = `${restaurants}/${created.id}`;
      const name = uniqueName();
      const updated = await request<Restaurant>('PUT', path, 200, JSON.stringify({
        name, rating: 5 - rating, id: other.id,
        created_at: forgedTimestamp, createdAt: forgedTimestamp, unexpected: true,
      }));
      assert.deepEqual(updated, { ...created, name, rating: 5 - rating });
      assert.deepEqual(await request('GET', path, 200), updated);
    }
    assert.deepEqual(await request('GET', `${restaurants}/${other.id}`, 200), other);
  });

  await t.test('POST and PUT reject malformed bodies and invalid restaurant fields', async (t) => {
    const parent = await createRestaurant({ rating: 4.5 });
    const name = uniqueName();
    const badBodies: [string, string][] = [
      ['empty body', ''],
      ['malformed JSON', '{"name":'],
      ...[null, [], 'text', 42, true].map(
        (body): [string, string] => [`non-object ${JSON.stringify(body)}`, JSON.stringify(body)]
      ),
      ['missing name', '{}'],
      ['blank name', JSON.stringify({ name: '  ' })],
      ['non-string name', JSON.stringify({ name: 12 })],
      ['long name', JSON.stringify({ name: `${name}${'x'.repeat(201)}` })],
      ['non-string cuisine', JSON.stringify({ name, cuisine: [] })],
      ['non-string address', JSON.stringify({ name, address: false })],
      ['negative rating', JSON.stringify({ name, rating: -0.01 })],
      ['rating above five', JSON.stringify({ name, rating: 5.01 })],
      ['string rating', JSON.stringify({ name, rating: '4.5' })],
      ['non-finite rating', `{"name":"${name}","rating":1e400}`],
      ...['name', 'cuisine', 'address'].map(
        (field): [string, string] => [
          `NUL ${field}`, JSON.stringify({ name, [field]: `${name}\u0000value` }),
        ]
      ),
    ];
    for (const [label, body] of badBodies) {
      await t.test(label, async () => {
        await request('POST', restaurants, 400, body);
        await request('PUT', `${restaurants}/${parent.id}`, 400, body);
      });
    }
    assert.deepEqual(await request('GET', `${restaurants}/${parent.id}`, 200), parent);
  });

  await t.test('invalid and overflow IDs are 404 for every implemented ID method', async (t) => {
    const parent = await createRestaurant();
    // Numeric-looking aliases target our ID even if a permissive parser regresses.
    const invalidIds = [
      'abc', '0', `-${parent.id}`, `${parent.id}.5`, `0${parent.id}`,
      `+${parent.id}`, `${parent.id}e0`, `0x${parent.id.toString(16)}`,
      ` ${parent.id} `, `${parent.id}suffix`, '2147483648', '9007199254740993',
    ];
    for (const id of invalidIds) {
      await t.test(JSON.stringify(id), async () => {
        const path = `${restaurants}/${encodeURIComponent(id)}`;
        await request('GET', path, 404);
        await request('PUT', path, 404, JSON.stringify({ name: uniqueName() }));
        await request('DELETE', path, 404);
        await request('GET', `${path}/visits`, 404);
        await request('POST', `${path}/visits`, 404, JSON.stringify({
          date: '2026-09-07', notes: uniqueName(),
        }));
      });
    }
    assert.deepEqual(await request('GET', `${restaurants}/${parent.id}`, 200), parent);
  });

  await t.test('a deleted owned parent is absent, not an empty visits collection', async () => {
    const parent = await createRestaurant();
    const path = `${restaurants}/${parent.id}`;
    await createVisit(parent.id, { amountSpent: 1 });
    await request('DELETE', path, 204);
    await request('GET', path, 404);
    await request('PUT', path, 404, JSON.stringify({ name: uniqueName() }));
    await request('DELETE', path, 404);
    await request('GET', `${path}/visits`, 404);
    await request('POST', `${path}/visits`, 404, JSON.stringify({
      date: '2026-09-07', notes: uniqueName(),
    }));
    await request('POST', `${path}/visits`, 404, '{');
  });

  await t.test('Part B shape, exact decimals, dates, tie order, and live GETs', async () => {
    const parent = await createRestaurant();
    const other = await createRestaurant();
    const path = `${restaurants}/${parent.id}/visits`;
    assert.deepEqual(await request('GET', path, 200), { visits: [], totalSpent: 0 });
    const first = await createVisit(parent.id, { date: '2024-02-29', amountSpent: 0.1 });
    const second = await createVisit(parent.id, { date: '2024-02-29', amountSpent: 0.2 });
    assert.equal(first.date, '2024-02-29');
    assert.equal(second.date, '2024-02-29');
    assert.equal(first.amountSpent, 0.1);
    assert.equal(second.amountSpent, 0.2);
    assert.deepEqual(await request('GET', path, 200), {
      visits: [second, first], totalSpent: 0.3,
    });

    const notes = uniqueName();
    const third = await createVisit(parent.id, {
      date: '2026-03-08', amountSpent: 12.34, notes: `  ${notes}  `,
      id: first.id, restaurantId: other.id, restaurant_id: other.id,
      amount_spent: 999, createdAt: forgedTimestamp, created_at: forgedTimestamp,
      unexpected: 'ignored\u0000field',
    });
    assert.equal(third.date, '2026-03-08');
    assert.equal(third.amountSpent, 12.34);
    assert.equal(third.notes, notes);
    assert.notEqual(third.id, first.id);
    assert.notEqual(third.createdAt, forgedTimestamp);
    const visits = [first, second, third];
    for (const date of ['2026-11-01', '2000-02-29', '0001-01-01', '0099-12-31']) {
      const visit = await createVisit(parent.id, { date, amountSpent: 0 });
      assert.equal(visit.date, date);
      assert.equal(visit.amountSpent, 0);
      visits.push(visit);
    }
    const omitted = await createVisit(parent.id, { notes: undefined });
    const nullable = await createVisit(parent.id, { amountSpent: null, notes: null });
    assert.equal(omitted.amountSpent, null);
    assert.equal(omitted.notes, null);
    assert.equal(nullable.amountSpent, null);
    assert.equal(nullable.notes, null);
    visits.push(omitted, nullable);
    visits.sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
    const result = await request<VisitsResponse>('GET', path, 200);
    assertVisits(result, parent.id);
    assert.deepEqual(result, { visits, totalSpent: 12.64 });
    assert.deepEqual(await request('GET', `${restaurants}/${other.id}/visits`, 200), {
      visits: [], totalSpent: 0,
    });
  });

  await t.test('visit validation rejects invalid dates, notes, and amounts', async (t) => {
    const parent = await createRestaurant();
    const path = `${restaurants}/${parent.id}/visits`;
    const valid = { date: '2026-09-07', notes: uniqueName() };
    const badBodies: [string, string][] = [
      ['empty body', ''],
      ['malformed JSON', '{"date":'],
      ...[null, [], 'text', 42, true].map(
        (body): [string, string] => [`non-object ${JSON.stringify(body)}`, JSON.stringify(body)]
      ),
      ['missing date', '{}'],
      ...[
        null, 123, '2026-02-29', '1900-02-29', '2026-02-30', '2026-13-01',
        '2026-00-01', '2026-01-00', '2026-04-31', '0000-01-01',
        '2026-9-7', '2026-09-07T00:00:00Z', '2026-09-07\u0000',
      ].map((date): [string, string] => [
        `invalid date ${JSON.stringify(date)}`, JSON.stringify({ ...valid, date }),
      ]),
      ['NUL notes', JSON.stringify({ ...valid, notes: `${valid.notes}\u0000value` })],
      ['non-string notes', JSON.stringify({ ...valid, notes: false })],
      ['long notes', JSON.stringify({ ...valid, notes: 'x'.repeat(1001) })],
      ...[-0.01, 0.001, 12.345, 0.1 + 0.2, 100000000, '12.34', false].map(
        (amountSpent): [string, string] => [
          `invalid amount ${JSON.stringify(amountSpent)}`,
          JSON.stringify({ ...valid, amountSpent }),
        ]
      ),
      ['non-finite amount', `{"date":"2026-09-07","notes":"${valid.notes}","amountSpent":1e400}`],
    ];
    for (const [label, body] of badBodies) {
      await t.test(label, async () => {
        await request('POST', path, 400, body);
      });
    }
    assert.deepEqual(await request('GET', path, 200), { visits: [], totalSpent: 0 });
  });

  await t.test('the maximum two-decimal amount round-trips without rounding', async () => {
    const parent = await createRestaurant();
    const visit = await createVisit(parent.id, { amountSpent: 99999999.99 });
    assert.equal(visit.amountSpent, 99999999.99);
    assert.deepEqual(await request('GET', `${restaurants}/${parent.id}/visits`, 200), {
      visits: [visit], totalSpent: 99999999.99,
    });
  });

  await t.test('modest concurrent reads and writes keep each list and total consistent', async () => {
    const parent = await createRestaurant();
    const path = `${restaurants}/${parent.id}/visits`;
    assert.deepEqual(await request('GET', path, 200), { visits: [], totalSpent: 0 });
    const written: Visit[] = [];
    const writers = [0, 1].map(async (worker) => {
      for (let index = 1; index <= 8; index++) {
        written.push(await createVisit(parent.id, { amountSpent: (worker * 8 + index) / 100 }));
      }
    });
    const readers = [0, 1].map(async () => {
      for (let index = 0; index < 16; index++) {
        assertVisits(await request<VisitsResponse>('GET', path, 200), parent.id);
      }
    });
    await settle([...writers, ...readers]);
    const result = await request<VisitsResponse>('GET', path, 200);
    assertVisits(result, parent.id);
    assert.equal(result.totalSpent, 1.36);
    assert.deepEqual(result.visits, written.sort((a, b) => b.id - a.id));
    assert.equal(result.visits.length, 16);
  });

  await t.test('missing parent during visit create returns 404, never a foreign-key 400', async () => {
    const parent = await createRestaurant();
    const path = `${restaurants}/${parent.id}`;
    const json = JSON.stringify({ date: '2026-09-07', amountSpent: 1, notes: uniqueName() });
    let upload: ReadableStreamDefaultController<Uint8Array> | undefined;
    // Keep JSON incomplete until DELETE completes; no sleeps or assumed query ordering.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        upload = controller;
        controller.enqueue(new TextEncoder().encode(json.slice(0, -1)));
      },
      cancel() { upload = undefined; },
    });
    const pending = settle([request('POST', `${path}/visits`, 404, body)]);
    // Attach a handler immediately in case the server rejects before DELETE finishes.
    pending.catch(() => {});
    try {
      await request('DELETE', path, 204);
    } finally {
      upload?.enqueue(new TextEncoder().encode('}'));
      upload?.close();
      await pending;
    }
    await request('GET', `${path}/visits`, 404);
    await request('POST', `${path}/visits`, 404, json);
  });
});
