import { NextResponse } from 'next/server';

/**
 * Central error -> HTTP response mapper for the API route handlers. Call it
 * from a route's `catch` block so error handling lives in one place:
 *
 *   try {
 *     ...
 *   } catch (err) {
 *     return handleError(err);
 *   }
 *
 * The routes `throw` instead of building 4xx responses inline, so every failure
 * body this API produces is shaped here, once. That is also what keeps
 * internals out of them: a `pg` failure carries the offending row in its
 * `detail` field ("Failing row contains (2, null, ...)") and the offending
 * value in its text, so no field of a caught error is ever copied into a
 * response. Every message below is written by hand.
 */

/** Base class for a failure that already knows its HTTP status. */
export class ApiError extends Error {
  constructor(
    /**
     * The statuses this API actually answers with, not `number`. A
     * body-forbidden or out-of-range status makes `handleError` itself throw
     * (`NextResponse.json` rejects a body on 204, and any status outside
     * 200-599 outright), and an error handler that throws is a 500 with an
     * empty body. Narrowing moves that from runtime to compile time.
     */
    readonly status: 400 | 404 | 409,
    message: string,
    /** Field-level problems, for a caller trying to fix their request. */
    readonly details?: string[]
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** 400. Carries every problem found, not just the first one. */
export class ValidationError extends ApiError {
  constructor(details: string[]) {
    super(400, 'Invalid request body', details);
  }
}

/** 404. Also the answer for an id that could never name a row - see parseId. */
export class NotFoundError extends ApiError {
  constructor(message = 'Not found') {
    super(404, message);
  }
}

/**
 * SQLSTATE -> what the caller gets told.
 *
 * Keyed on `err.code`, never on `err.name`: node-postgres builds the error from
 * the protocol message, so `name` is the literal string "error" - not
 * "DatabaseError". `code` is the five-character SQLSTATE and is the only
 * reliable discriminator.
 *
 * These are the constraint failures a caller can still provoke after
 * validation, so they are answers, not bugs. Anything else falls through to the
 * generic 500 below.
 *
 * A Map rather than an object literal, because the lookup is keyed on attacker-
 * adjacent input: `PG_ERRORS['constructor']` on a literal walks up to
 * `Object.prototype` and answers with a truthy function, whose `.status` and
 * `.message` are `undefined` - and `NextResponse.json({error: undefined},
 * {status: undefined})` is a 200 with an empty body. A Map has no prototype
 * chain to walk, so it cannot answer for a key nobody put in it.
 */
const PG_ERRORS = new Map<string, { status: 400 | 409; message: string }>([
  ['22003', { status: 400, message: 'A numeric value is too large' }], // numeric_value_out_of_range
  ['22P02', { status: 400, message: 'Invalid value for one or more fields' }], // invalid_text_representation
  ['23502', { status: 400, message: 'A required field is missing' }], // not_null_violation
  ['23503', { status: 400, message: 'Referenced record does not exist' }], // foreign_key_violation
  ['23505', { status: 409, message: 'That record already exists' }], // unique_violation
  ['23514', { status: 400, message: 'A field is outside its allowed range' }], // check_violation
]);

/** The SQLSTATE of a `pg` error, or '' if this isn't one. */
function sqlState(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : '';
}

function body(status: number, error: string, details?: string[]): NextResponse {
  return NextResponse.json(details ? { error, details } : { error }, { status });
}

export function handleError(err: unknown): NextResponse {
  // Our own errors, and only ours: every one of these strings is a literal from
  // this file or a field name from the validator, so it is safe to send back.
  if (err instanceof ApiError) {
    const { status, message, details } = err;
    return body(status, message, details);
  }

  // `req.json()` throws a SyntaxError for malformed JSON *and* for an empty
  // body. Matched by type, never by message text - the wording differs between
  // Node versions, so a string check would silently start returning 500s on an
  // upgrade.
  if (err instanceof SyntaxError) {
    return body(400, 'Invalid JSON body');
  }

  // Past this point the error came from the database, so log the real thing
  // server-side. Nothing below reads from `err` again.
  const pg = PG_ERRORS.get(sqlState(err));
  if (pg) {
    // Answered, but still logged: a constraint we expected to be unreachable
    // firing in production is a schema surprise worth seeing.
    console.error('Handled pg constraint error:', err);
    return body(pg.status, pg.message);
  }

  // Genuinely unanticipated - the only branch the label was ever true for.
  console.error('Unhandled API error:', err);
  return body(500, 'Internal Server Error');
}
