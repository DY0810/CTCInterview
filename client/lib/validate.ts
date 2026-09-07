/**
 * Runtime checks on request input.
 *
 * `lib/types.ts` describes the shapes this API speaks, but those are TypeScript
 * types: erased at build time, validating nothing. A parsed request body is
 * `unknown` no matter what it claims to be, and this file is what turns it into
 * something safe to hand to a query.
 *
 * Hand-rolled rather than a schema library: four fields and one id format don't
 * justify a dependency, and everything here is explicit enough to read in one
 * sitting. If the number of endpoints grows, that trade flips.
 */
import { ValidationError } from './errors';

/** The largest value a SERIAL (int4) primary key can hold. */
const MAX_ID = 2147483647;

/**
 * A route `:id` segment -> a row id, or `null` if it can't be one.
 *
 * Deliberately not `Number()`, which is far too generous for this: it accepts
 * hex (`Number('0x10')` is 16), exponents (`Number('1e3')` is 1000), surrounding
 * whitespace (`Number(' 1 ')` is 1) and the empty string (`Number('')` is 0). So
 * `/api/restaurants/0x10` would quietly serve restaurant 16. A digits-only test
 * is the honest definition of "a positive whole number", and it also rejects
 * `abc`, `-1`, `1.5` and `0`.
 *
 * `null` means 404, not 400: an id that isn't a positive integer names no
 * restaurant, and "there is no such restaurant" is the answer the contract asks
 * for. Checking it here also keeps the value away from Postgres, which would
 * otherwise raise 22P02 on `abc`.
 */
export function parseId(raw: string): number | null {
  if (!/^[1-9]\d*$/.test(raw)) return null;
  // `id` is SERIAL, i.e. int4, so a larger number cannot name a row either -
  // and handing it to Postgres raises 22003 rather than returning zero rows.
  // Same reasoning as above: no such restaurant, so 404.
  const id = Number(raw);
  return id <= MAX_ID ? id : null;
}

/** A restaurant body that has been checked and is safe to store. */
export interface RestaurantInput {
  name: string;
  cuisine: string | null;
  address: string | null;
  rating: number | null;
}

/** Long enough for any real restaurant name, short enough to bound the column. */
const MAX_NAME_LENGTH = 200;

/**
 * Reject a NUL character in any of `fields`.
 *
 * One rule for every text field, because it is a property of the column and not
 * of any one of them: a `text` column cannot hold U+0000, and Postgres rejects
 * the write with an error this API does not map - a 500 for something the
 * caller sent. `"a\u0000b"` is perfectly legal JSON, and it survives every
 * other check here (non-empty once trimmed, well under any length cap), so
 * nothing else stops it. The caller sent something the column cannot store,
 * which is a 400.
 *
 * Shared by both validators so `notes` cannot drift from `name` on a rule that
 * belongs to the storage, not to the field.
 */
function checkNoNul(
  fields: Record<string, unknown>,
  problems: string[]
): void {
  for (const [field, value] of Object.entries(fields)) {
    if (typeof value === 'string' && value.includes('\u0000')) {
      problems.push(`${field} must not contain a NUL character`);
    }
  }
}

/**
 * Optional free text: absent or null -> null, a string -> trimmed. Anything
 * else records a problem and is dropped.
 */
function optionalText(
  value: unknown,
  field: string,
  problems: string[]
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    problems.push(`${field} must be a string or null`);
    return null;
  }
  // Whitespace-only means "no value", so store null and not ''. The column is
  // nullable, and letting both through gives "no cuisine" two representations -
  // one of which every `IS NULL`, `COALESCE` and `GROUP BY` would get wrong.
  // It also matches `name`, where whitespace-only is already rejected.
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Validate a restaurant body. Shared by POST and PUT so the two cannot drift -
 * PUT is a full replacement, so it has exactly the same requirements as a
 * create, including `name`.
 *
 * Throws ValidationError (400) listing *every* problem. Failing on the first
 * one turns fixing a request into a guessing game, one round trip per field.
 */
export function parseRestaurantBody(payload: unknown): RestaurantInput {
  // Guard the container before destructuring anything out of it. `req.json()`
  // resolves happily for `null`, `[]`, `"foo"` and `123` - all valid JSON - and
  // `const { name } = null` throws a TypeError, while an array or a bare string
  // yields `undefined` for every field and only fails later, on the NOT NULL
  // constraint on `name`, as a 500.
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload)
  ) {
    throw new ValidationError(['body must be a JSON object']);
  }

  // Unknown fields are ignored, not rejected: an extra key is usually a client
  // running ahead of the server, not an attack, and only the four names below
  // are ever read. The trade is that a typo'd field is accepted silently.
  const { name, cuisine, address, rating } = payload as Record<string, unknown>;

  const problems: string[] = [];

  checkNoNul({ name, cuisine, address }, problems);

  let cleanName = '';
  if (typeof name !== 'string') {
    problems.push(
      name === undefined ? 'name is required' : 'name must be a string'
    );
  } else {
    const trimmed = name.trim();
    if (trimmed === '') {
      problems.push('name must not be empty');
    } else if (trimmed.length > MAX_NAME_LENGTH) {
      problems.push(`name must be ${MAX_NAME_LENGTH} characters or fewer`);
    } else {
      cleanName = trimmed;
    }
  }

  const cleanCuisine = optionalText(cuisine, 'cuisine', problems);
  const cleanAddress = optionalText(address, 'address', problems);

  // `null` is accepted as well as absent: `rating` is a nullable column, an
  // omitted field already becomes null on this full-replacement PUT, and
  // refusing an explicit null would leave no way to clear a rating.
  let cleanRating: number | null = null;
  if (rating !== undefined && rating !== null) {
    if (typeof rating !== 'number' || !Number.isFinite(rating)) {
      // Rejects the string "4.5" along with NaN and Infinity. JSON has a number
      // type, so a caller sending a string is sending something else.
      problems.push('rating must be a number');
    } else if (rating < 0 || rating > 5) {
      // The only thing standing between a user and a rating of 6: the migration
      // declares `rating NUMERIC` with no CHECK, so the database would store it.
      problems.push('rating must be between 0 and 5');
    } else {
      cleanRating = rating;
    }
  }

  if (problems.length > 0) {
    throw new ValidationError(problems);
  }

  return {
    name: cleanName,
    cuisine: cleanCuisine,
    address: cleanAddress,
    rating: cleanRating,
  };
}

/** A visit body that has been checked and is safe to store. */
export interface VisitInput {
  date: string;
  amountSpent: number | null;
  notes: string | null;
}

/** NUMERIC(10, 2) holds ten digits, two of them after the point. */
const MAX_AMOUNT = 99999999.99;

/** Room for a real note about a meal, without letting the column grow unbounded. */
const MAX_NOTES_LENGTH = 1000;

/**
 * "YYYY-MM-DD" -> does it name a day that actually exists?
 *
 * The shape test alone isn't enough: `2026-02-30` and `2026-13-01` both match
 * the pattern, and `new Date` silently rolls them forward to March 2nd and
 * January 2027 rather than rejecting them - so the stored date would be a day
 * the caller never sent. Round-tripping the three parts back out is what
 * catches that, and it also rejects month 00 and day 00, which roll backwards.
 *
 * Built in UTC purely to keep this a calendar calculation; the local-time
 * constructor is the one that can shift a day across a timezone. The validated
 * string goes to Postgres as a string, never as a Date.
 */
function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;

  const [, year, month, day] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/**
 * Validate a visit body for POST /api/restaurants/:id/visits.
 *
 * `restaurantId` is deliberately not read from the body - it comes from the
 * URL, which is the only copy. Accepting it in both places invites a request
 * whose two halves disagree, and then a rule about which one wins.
 *
 * Throws ValidationError (400) listing every problem, same as the restaurant
 * validator above.
 */
export function parseVisitBody(payload: unknown): VisitInput {
  // Same container guard as parseRestaurantBody: `null`, `[]` and `"foo"` are
  // all valid JSON, and destructuring the first one throws a TypeError.
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload)
  ) {
    throw new ValidationError(['body must be a JSON object']);
  }

  // Unknown fields ignored rather than rejected, matching the restaurant body.
  const { date, amountSpent, notes } = payload as Record<string, unknown>;

  const problems: string[] = [];

  // Only `notes` here: a NUL in `date` is already caught by isCalendarDate
  // below, and reporting it twice describes one problem as two.
  checkNoNul({ notes }, problems);

  // `date` is required: a visit that records money but not when it was spent is
  // useless for the one question this app exists to answer. The column is NOT
  // NULL anyway, so skipping the check would only move the failure to a 23502
  // the caller can't read.
  //
  // A date in the future is allowed. The server cannot know what "today" is for
  // the caller - it is a day behind or ahead of most of the planet - so a
  // not-in-the-future rule would reject a legitimate entry logged this evening
  // from the wrong side of a date line. Booking a table for next week and
  // logging it now is also a reasonable thing to want. Dates that cannot exist
  // are a different question, and isCalendarDate answers that one.
  let cleanDate = '';
  if (typeof date !== 'string') {
    problems.push(
      date === undefined ? 'date is required' : 'date must be a string'
    );
  } else if (!isCalendarDate(date)) {
    problems.push('date must be a real calendar date in YYYY-MM-DD form');
  } else {
    cleanDate = date;
  }

  // Optional, and an explicit null is accepted as well as absent: you can
  // remember eating somewhere without remembering the bill, and the column is
  // nullable.
  let cleanAmount: number | null = null;
  if (amountSpent !== undefined && amountSpent !== null) {
    if (typeof amountSpent !== 'number' || !Number.isFinite(amountSpent)) {
      // Rejects the string "42.50" along with NaN and Infinity, the same rule
      // `rating` uses. JSON has a number type; a caller sending a string means
      // something else by it.
      problems.push('amountSpent must be a number');
    } else if (amountSpent < 0) {
      // Also enforced by the CHECK in migration 002. Here it is a 400 the
      // caller can read, rather than a constraint violation.
      problems.push('amountSpent must not be negative');
    } else if (amountSpent > MAX_AMOUNT) {
      // Past this, NUMERIC(10, 2) overflows and Postgres raises 22003.
      problems.push(`amountSpent must be ${MAX_AMOUNT} or less`);
    } else if (Number(amountSpent.toFixed(2)) !== amountSpent) {
      // Rejected, not rounded. The column keeps two decimals, so 12.999 would
      // be stored as 13.00: the 201 would hand back a number the caller never
      // sent, and every total after it would disagree with the receipt by a
      // cent nobody can trace. Money is the field where quietly changing the
      // value is worse than refusing it, so the caller decides how to round.
      // Comparing through toFixed also catches 0.1 + 0.2 and 1e-7, which a
      // naive `value * 100` check does not.
      problems.push('amountSpent must have at most 2 decimal places');
    } else {
      cleanAmount = amountSpent;
    }
  }

  const cleanNotes = optionalText(notes, 'notes', problems);
  if (cleanNotes !== null && cleanNotes.length > MAX_NOTES_LENGTH) {
    problems.push(`notes must be ${MAX_NOTES_LENGTH} characters or fewer`);
  }

  if (problems.length > 0) {
    throw new ValidationError(problems);
  }

  return { date: cleanDate, amountSpent: cleanAmount, notes: cleanNotes };
}
