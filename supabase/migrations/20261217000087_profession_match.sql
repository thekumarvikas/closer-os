-- Round 15 · 1b) Matching a profession to its group was the single biggest cost in a
-- lead import: 3.8 ms per lead on a company with 16 groups and 185 keywords.
--
-- categorize_profession built and ran one regular expression PER KEYWORD, per lead —
-- 185 patterns compiled from scratch every time, for every row. The keywords only
-- change when a manager edits them, so the pattern is now built once per group and
-- kept on the row. Matching a lead is then 16 ready-made patterns instead of 185 built
-- from scratch. Same rule, same word-boundary behaviour, same result.

alter table public.profession_categories add column if not exists match_re text;

-- One pattern per group: any keyword, each on a word boundary.
create or replace function public.profession_match_re(p_keywords text[])
returns text language sql immutable set search_path = '' as $$
  select case when x.alt = '' then null
              else '(^|[^a-z0-9])(' || x.alt || ')($|[^a-z0-9])' end
  from (
    select coalesce(string_agg(regexp_replace(lower(trim(k)), '([^a-z0-9 ])', '\\\1', 'g'), '|'), '') as alt
    from unnest(coalesce(p_keywords, '{}'::text[])) k
    where length(trim(k)) > 0
  ) x
$$;

create or replace function public.t_prof_match() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.match_re := public.profession_match_re(new.keywords);
  return new;
end $$;
drop trigger if exists t_prof_match on public.profession_categories;
create trigger t_prof_match before insert or update of keywords on public.profession_categories
  for each row execute function public.t_prof_match();

update public.profession_categories set match_re = public.profession_match_re(keywords)
where match_re is distinct from public.profession_match_re(keywords);

create or replace function public.categorize_profession(p_org uuid, p_profession text)
returns uuid language sql stable security definer set search_path = '' as $$
  select c.id from public.profession_categories c
  where c.org_id = p_org
    and p_profession is not null
    and c.match_re is not null
    and lower(p_profession) ~ c.match_re
  order by c.position, c.name
  limit 1
$$;
