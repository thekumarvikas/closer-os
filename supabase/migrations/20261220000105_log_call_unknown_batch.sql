-- A phone could hold a webinar that was deleted or merged since (Cancer, Nov 20: outcomes for Nikhil's calls were
-- refused with "Unknown webinar batch", so those calls never reached Closer OS). Now the call is saved anyway and the
-- right webinar is picked by the usual rules (t_call_webinar).
do $$ declare d text; begin
  d := pg_get_functiondef('public.log_call(jsonb)'::regprocedure);
  d := replace(d, $x$  if v_batch is not null and not exists (select 1 from public.batches where id = v_batch and org_id = v_org) then
    raise exception 'Unknown webinar batch';
  end if;$x$, $x$  if v_batch is not null and not exists (select 1 from public.batches where id = v_batch and org_id = v_org and not is_archived) then
    v_batch := null;
  end if;$x$);
  if position('Unknown webinar batch' in d) > 0 then raise exception 'patch did not apply'; end if;
  execute d;
end $$;
