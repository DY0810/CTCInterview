import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ErrorPage from '../app/error';
import { pool } from '../db/pool';
import { ApiError, handleError, NotFoundError, ValidationError } from '../lib/errors';
import { parseId, parseRestaurantBody, parseVisitBody } from '../lib/validate';
import { toRestaurant, toVisit } from '../lib/types';
import { getRestaurant, getVisits as fetchVisits } from '../lib/apiClient';
import {
  GET as getVisits,
  POST as postVisit,
} from '../app/api/restaurants/[id]/visits/route';

after(() => pool.end());

const timestamp = new Date('2026-01-12T08:00:00.000Z');
const restaurant = {
  id: 1, name: 'Lunch', cuisine: null, address: null,
  rating: '4.5', created_at: timestamp,
};
const visit = {
  id: 1, restaurantId: 1, date: new Date(2026, 0, 12),
  amountSpent: '10.10', notes: null, created_at: timestamp,
};
const context = { params: { id: '1' } };
const url = 'http://localhost/api/restaurants/1/visits';

test('database names and values become the exact restaurant response', () => {
  assert.deepEqual(toRestaurant(restaurant), {
    id: 1, name: 'Lunch', cuisine: null, address: null,
    rating: 4.5, createdAt: timestamp.toISOString(),
  });
  assert.equal(toRestaurant({ ...restaurant, rating: null }).rating, null);
  assert.equal(toRestaurant({ ...restaurant, rating: '0' }).rating, 0);
});

test('missing or invalid database timestamps fail instead of becoming successful bad data', () => {
  for (const created_at of [undefined, null, '', 'not-a-date', new Date(NaN)]) {
    assert.throws(() => toRestaurant({ ...restaurant, created_at }));
    assert.throws(() => toVisit({ ...visit, created_at }));
  }
  assert.equal(
    toRestaurant({ ...restaurant, created_at: timestamp.toISOString() }).createdAt,
    timestamp.toISOString()
  );
});

test('calendar dates retain their day in the process timezone', () => {
  assert.deepEqual(toVisit(visit), {
    id: 1, restaurantId: 1, date: '2026-01-12', amountSpent: 10.1,
    notes: null, createdAt: timestamp.toISOString(),
  });
  assert.equal(toVisit({ ...visit, date: '2024-02-29' }).date, '2024-02-29');
});

test('calendar years below 100 are not rewritten as 1900s or shortened', () => {
  for (const date of ['0001-01-01', '0099-12-31', '0100-01-01', '0999-12-31']) {
    assert.equal(parseVisitBody({ date }).date, date);
    const [year, month, day] = date.split('-').map(Number);
    const localDate = new Date(2000, 0, 1);
    localDate.setFullYear(year, month - 1, day);
    assert.equal(toVisit({ ...visit, date: localDate }).date, date);
  }
});

test('IDs are positive decimal int4 values only', () => {
  assert.equal(parseId('1'), 1);
  assert.equal(parseId('2147483647'), 2147483647);
  for (const raw of [
    '', '0', '-1', '1.5', 'abc', '01', '0x10', '1e3', '+1', ' 1 ',
    '2147483648', '99999999999999999999',
  ]) assert.equal(parseId(raw), null, raw);
});

test('both input validators reject non-object JSON', () => {
  for (const body of [null, [], 'text', 42, true]) {
    assert.throws(() => parseRestaurantBody(body), ValidationError);
    assert.throws(() => parseVisitBody(body), ValidationError);
  }
});

test('restaurant validation keeps zero, clears blanks, and ignores protected fields', () => {
  assert.deepEqual(parseRestaurantBody({
    name: ' Lunch ', cuisine: ' ', address: '', rating: 0,
    id: 500, createdAt: 'forged',
  }), { name: 'Lunch', cuisine: null, address: null, rating: 0 });
  assert.equal(parseRestaurantBody({ name: 'Lunch', rating: 5 }).rating, 5);
  for (const rating of [-1, 6, '4.5', true, NaN, Infinity]) {
    assert.throws(() => parseRestaurantBody({ name: 'Lunch', rating }), ValidationError);
  }
  for (const name of [undefined, null, 123, '', ' ']) {
    assert.throws(() => parseRestaurantBody({ name }), ValidationError);
  }
});

test('text length limits count Unicode characters, not storage units', () => {
  const character = String.fromCodePoint(0x1f355);
  assert.equal(parseRestaurantBody({ name: character.repeat(200) }).name, character.repeat(200));
  assert.throws(() => parseRestaurantBody({ name: character.repeat(201) }), ValidationError);
  assert.equal(
    parseVisitBody({ date: '2026-01-12', notes: character.repeat(1000) }).notes,
    character.repeat(1000)
  );
  assert.throws(
    () => parseVisitBody({ date: '2026-01-12', notes: character.repeat(1001) }),
    ValidationError
  );
});

test('every writable text field rejects NUL and reports all problems', () => {
  assert.throws(
    () => parseRestaurantBody({ name: 'a\u0000b', cuisine: '\u0000', address: '\u0000' }),
    (error: unknown) => error instanceof ValidationError && error.details?.length === 3
  );
  assert.throws(
    () => parseVisitBody({ date: '2026-01-12', notes: 'a\u0000b' }),
    ValidationError
  );
});

test('visit validation checks real days and exact cents without rounding', () => {
  for (const date of ['0000-01-01', '2026-02-29', '2026-02-30', '2026-00-01', '2026-13-01', '2026-01-00', '2026-1-1']) {
    assert.throws(() => parseVisitBody({ date }), ValidationError, date);
  }
  for (const amountSpent of [-1, 12.999, 0.1 + 0.2, '10', NaN, Infinity, 100000000]) {
    assert.throws(() => parseVisitBody({ date: '2024-02-29', amountSpent }), ValidationError);
  }
  for (const amountSpent of [0, 10.1, 20.2, 99999999.99, null]) {
    assert.equal(parseVisitBody({ date: '2024-02-29', amountSpent }).amountSpent, amountSpent);
  }
});

test('error mapping keeps private details out and never follows object prototype keys', async (t) => {
  t.mock.method(console, 'error', () => {});
  for (const [code, status] of [
    ['22003', 400], ['22P02', 400], ['23502', 400], ['23503', 400],
    ['23505', 409], ['23514', 400], ['constructor', 500],
    ['__proto__', 500], ['toString', 500],
  ] as const) {
    const response = handleError({ code, name: 'error', message: 'private row', detail: 'private row', stack: 'private row' });
    assert.equal(response.status, status, code);
    assert.equal((await response.text()).includes('private row'), false);
  }
  assert.equal(handleError(new NotFoundError()).status, 404);
  assert.equal(handleError(new ApiError(409, 'Conflict')).status, 409);
  assert.equal(handleError(new ValidationError(['name is required'])).status, 400);
  assert.equal(handleError(new SyntaxError()).status, 400);
  assert.equal(handleError(new Error('private row')).status, 500);
});

test('the visit list and total describe the same database snapshot', async (t) => {
  // Simulate another writer committing between separate SELECT statements.
  // The HTTP suite additionally checks the real SQL against PostgreSQL.
  t.mock.method(pool, 'query', async (sql: string) => {
    if (sql.includes('JOIN visits')) return { rows: [{ ...visit, total: '10.10' }] };
    if (sql.includes('SELECT 1')) return { rows: [{ exists: 1 }] };
    if (sql.includes('SUM(')) return { rows: [{ total: '30.30' }] };
    return { rows: [visit] };
  });
  const response = await getVisits(new Request(url), context);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.visits.length, 1);
  assert.equal(body.totalSpent, body.visits[0].amountSpent);
});

test('a restaurant removed after the parent check produces 404 on visit creation', async (t) => {
  t.mock.method(console, 'error', () => {});
  t.mock.method(pool, 'query', async (sql: string) => {
    if (sql.includes('SELECT 1')) return { rows: [{ exists: 1 }] };
    if (sql.includes('FOR KEY SHARE')) return { rows: [] };
    throw Object.assign(new Error('private foreign key detail'), { code: '23503' });
  });
  const response = await postVisit(new Request(url, {
    method: 'POST',
    body: JSON.stringify({ date: '2026-01-12', amountSpent: 10.1 }),
  }), context);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'Restaurant not found' });
});

test('page fetch helpers keep IDs inside one URL segment', async (t) => {
  let requested = '';
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    requested = String(input);
    return new Response(null, { status: 404 });
  });
  assert.equal(await getRestaurant('1/../2'), null);
  assert.equal(new URL(requested).pathname, '/api/restaurants/1%2F..%2F2');
  assert.equal(await fetchVisits('1/../2'), null);
  assert.equal(new URL(requested).pathname, '/api/restaurants/1%2F..%2F2/visits');
});

test('page failures have an accessible, generic retry screen', () => {
  const html = renderToStaticMarkup(createElement(ErrorPage));
  assert.match(html, /role="alert"/);
  assert.match(html, /Could not load this page/);
  assert.match(html, /<button type="button"/);
  assert.match(html, /Try again/);
});
