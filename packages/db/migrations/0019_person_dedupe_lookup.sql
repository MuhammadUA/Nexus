-- ---------------------------------------------------------------------------
-- 0019 — person dedupe by canonical LinkedIn URL, independent of lead visibility
--
-- `people_normalized_linkedin_key` is a global unique index, and both ingestion paths look a Person
-- up by it before inserting. That lookup ran under `people`'s RLS policy, which is
-- `person_visible(id)` — true only for an administrator, or when the Person has a Lead in a business
-- the actor can reach.
--
-- A Person captured by a Companion operator has neither, unless the operator is an administrator and
-- the Lead write succeeded. So on the *second* capture of the same profile the lookup returned
-- nothing, the route tried to insert a second Person, and the unique index refused it — surfacing as
-- "The capture could not be saved." for a capture that should simply have found the record it created
-- a moment earlier. The same shape of failure affects the web import path.
--
-- Dedupe is a data-integrity question, not a visibility question: two rows may not exist, regardless
-- of who is looking. This helper answers it in one place, so both paths share one implementation and
-- it cannot drift from the index it exists to honour.
--
-- The key is normalized *here* by `normalize_linkedin_url` — the same function
-- `normalize_person_row` applies on write. Doing it in the caller instead would mean the lookup and
-- the column could disagree: the TypeScript canonicalizer produces
-- `https://www.linkedin.com/in/<slug>` while the column holds `linkedin.com/in/<slug>`, and a lookup
-- with the former matched nothing at all.
--
-- It returns an id and nothing else: no field of the Person is exposed, so an actor who could not
-- read the record still learns only that a record exists — which the unique index would tell them
-- anyway by refusing their insert.
-- ---------------------------------------------------------------------------

-- `drop` before `create`: Postgres refuses `create or replace` when an input parameter's *name*
-- changes, and this function's parameter was renamed while it was being written. A migration set has
-- to apply over an existing database as well as a fresh one, so the old signature is removed first.
drop function if exists public.find_person_id_by_linkedin_url(text);

create or replace function public.find_person_id_by_linkedin_url(p_url text)
  returns uuid
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select p.id
    from public.people p
   where p.normalized_linkedin_url = public.normalize_linkedin_url(p_url)
     and public.normalize_linkedin_url(p_url) is not null
     -- A soft-deleted Person is still a row the unique index sees, so it is still the record to
     -- reuse; reviving it is the caller's decision.
   order by p.deleted_at nulls first, p.created_at
   limit 1;
$$;

comment on function public.find_person_id_by_linkedin_url(text) is
  'Returns the id of the Person whose canonical LinkedIn URL matches, across all rows, so ingestion dedupes on the same key as people_normalized_linkedin_key. Normalizes through normalize_linkedin_url and discloses an id only.';

grant execute on function public.find_person_id_by_linkedin_url(text) to authenticated;
