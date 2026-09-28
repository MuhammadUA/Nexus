-- Keep the canonical LinkedIn dedupe key populated when the controlled
-- ingestion helper creates a Person. Migration 0028 contains the converged
-- definition for fresh databases; this migration upgrades databases that
-- already applied its first deployed revision.
create or replace function public.nexus_resolve_or_create_person(
  p_business_id uuid,
  p_full_name text,
  p_normalized_name text,
  p_job_title text,
  p_location text,
  p_linkedin_url text,
  p_headline text,
  p_created_by uuid
)
  returns uuid
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if not (
    public.is_admin()
    or (public.has_business_access(p_business_id) and public.can_use_lead_sources(p_business_id))
    or public.is_api_client_allowed(p_business_id, 'leads:write')
    or public.is_api_client_allowed(p_business_id, 'lead_sources:write')
  ) then
    raise exception 'canonical person creation is not permitted' using errcode = '42501';
  end if;

  if p_linkedin_url is not null then
    select p.id into v_id
      from public.people p
     where p.normalized_linkedin_url = p_linkedin_url
     limit 1;
  end if;

  if v_id is null then
    insert into public.people
      (full_name, normalized_name, job_title, location, linkedin_url,
       normalized_linkedin_url, headline, created_by)
    values
      (p_full_name, p_normalized_name, p_job_title, p_location, p_linkedin_url,
       p_linkedin_url, p_headline, p_created_by)
    returning id into v_id;
  end if;

  return v_id;
end
$$;

revoke all on function public.nexus_resolve_or_create_person(uuid, text, text, text, text, text, text, uuid)
  from public, anon;
grant execute on function public.nexus_resolve_or_create_person(uuid, text, text, text, text, text, text, uuid)
  to authenticated;
