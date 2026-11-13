# Authorization and Data Isolation (slug: `authz-isolation`)

Load this when the target has a database, row-level-security policies, per-user or per-tenant data,
or service-level API keys. The Evidence Discipline and Output Format in `SKILL.md` apply unchanged.

## What to look for

- Handlers that take a record id from the request and fetch or change it without checking that the
  caller owns it.
- Queries on shared tables that omit the tenant or owner filter, or take that filter from a
  client-supplied value.
- Over-broad keys: a service or admin key used on a path that serves end users, or a key shipped to
  the browser or a mobile client.
- Row-level security gaps: a table holding per-user data with security disabled, a table with
  security enabled but no policy where access is expected, or a policy whose condition is always
  true or does not reference the caller.
- Write policies that check the row being read but not the row being written.
- Views, functions, or stored procedures that run with the owner's rights and bypass the policies on
  the tables underneath.

## What counts as evidence

- The handler or query quoted, showing the id or filter source and the absent ownership check.
- The policy or migration text quoted, with the table name and the permissive condition.
- The place the broad key is read and the path that reaches end users.

## What does not count

- A table that holds only public reference data.
- A service key used only in a trusted server job with no user-facing entry.
- A missing check in a handler whose caller is already limited by a policy you have read and
  confirmed.
- A policy you expect to be missing. Read the migrations first; if they are not in scope, say so.

## Verdict rules

A finding needs a location and quoted evidence. A missing second layer, such as an app-level check
absent where a restrictive policy already blocks the access, is a hardening note, not a
vulnerability. If the outcome turns on a fact you cannot read, such as the live policy set in a
deployed database, give it the needs-validation verdict with a read-only way to settle it. Do not query a
live database to settle it.
