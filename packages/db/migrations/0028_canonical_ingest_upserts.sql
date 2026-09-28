-- ============================================================================
-- NEXUS DB - 0028 canonical identity ingestion boundary
--
-- companies and people are global rows whose SELECT visibility is derived from
-- an existing business lead. During ingestion the canonical row must be created
-- before that lead exists, so INSERT ... RETURNING cannot satisfy the SELECT
-- policy in the same statement. These narrowly-scoped SECURITY DEFINER helpers
-- perform only the required resolve-or-create operation after checking the
-- caller's business capability. Table RLS remains unchanged.
-- ============================================================================

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

create or replace function public.nexus_resolve_or_create_company(
  p_business_id uuid,
  p_name text,
  p_normalized_name text,
  p_domain text,
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
    raise exception 'canonical company creation is not permitted' using errcode = '42501';
  end if;

  select c.id into v_id
    from public.companies c
   where c.deleted_at is null
     and ((p_domain is not null and c.normalized_domain = p_domain)
          or c.normalized_name = p_normalized_name)
   limit 1;

  if v_id is null then
    insert into public.companies
      (name, normalized_name, primary_domain, normalized_domain, created_by)
    values
      (p_name, p_normalized_name, p_domain, p_domain, p_created_by)
    returning id into v_id;
  end if;

  return v_id;
end
$$;

revoke all on function public.nexus_resolve_or_create_person(uuid, text, text, text, text, text, text, uuid)
  from public, anon;
revoke all on function public.nexus_resolve_or_create_company(uuid, text, text, text, uuid)
  from public, anon;
grant execute on function public.nexus_resolve_or_create_person(uuid, text, text, text, text, text, text, uuid)
  to authenticated;
grant execute on function public.nexus_resolve_or_create_company(uuid, text, text, text, uuid)
  to authenticated;
