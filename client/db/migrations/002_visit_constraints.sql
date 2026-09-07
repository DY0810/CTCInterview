-- Migration 002: stop the database from storing a negative amount spent.
--
-- A new file rather than an edit to 001. The runner keeps no ledger and 001 is
-- written with CREATE TABLE IF NOT EXISTS, so an edit there does nothing on a
-- database that already has the tables - while `npm run migrate` still prints
-- "Applied N migration(s)." as if it had worked. ALTER TABLE in an 002 is the
-- way. See db/migrate.ts.
--
-- Part B validates `amountSpent >= 0` in lib/validate.ts before any insert, so
-- this is not the only guard. It is the one that survives a second writer: the
-- seed script, a psql session, or whatever calls this database next. A rule
-- about what the column may hold belongs to the column.
--
-- Written to be re-runnable, because the runner executes every file on every
-- run. Postgres has no ADD CONSTRAINT IF NOT EXISTS, so drop first; a
-- multi-statement query runs in one implicit transaction, so the constraint is
-- never actually absent from the point of view of another session.
ALTER TABLE visits DROP CONSTRAINT IF EXISTS visits_amount_nonneg;

ALTER TABLE visits ADD CONSTRAINT visits_amount_nonneg
  CHECK ("amountSpent" IS NULL OR "amountSpent" >= 0);
