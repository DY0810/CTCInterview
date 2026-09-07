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

  // One rule for every text field, because it is a property of the column and
  // not of any one of them: a `text` column cannot hold U+0000, and Postgres
  // rejects the write with an error this API does not map - a 500 for something
  // the caller sent. `"a\u0000b"` is perfectly legal JSON, and it survives the
  // checks below (non-empty once trimmed, well under the length cap), so
  // nothing else stops it. The caller sent something the column cannot store,
  // which is a 400.
  for (const [field, value] of Object.entries({ name, cuisine, address })) {
    if (typeof value === 'string' && value.includes('\u0000')) {
      problems.push(`${field} must not contain a NUL character`);
    }
  }

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
