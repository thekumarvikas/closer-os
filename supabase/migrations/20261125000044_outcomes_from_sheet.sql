-- Owner's sheet: bring back the webinar reminder outcomes (Guided, Incoming calls not available, Invalid number…)
-- with the sheet's names and order; add Incoming calls not available / Invalid number / Disconnected after intro to sales.
CREATE OR REPLACE FUNCTION public.apply_outcome_set_v2(p_org uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  with v(code, label, category, form, purpose, pos, nxt) as (values
    -- Sales · didn't connect
    ('no_answer',        'No answer',                          'not_connected', null,       'sales', 1,  '2h'),
    ('busy',             'Busy / cut the call',                'not_connected', null,       'sales', 2,  '1h'),
    ('not_reachable',    'Switched off / not reachable',       'not_connected', null,       'sales', 3,  'tomorrow'),
    ('not_in_service',   'Number not in service',              'invalid',       null,       'sales', 4,  'none'),
    ('incoming_na',      'Incoming calls not available',       'not_connected', null,       'sales', 5,  'tomorrow'),
    ('invalid_number',   'Invalid number',                     'invalid',       null,       'sales', 6,  'none'),
    -- Sales · connected, no real talk
    ('call_back',        'Asked to call back later',           'connected',     null,       'sales', 10, 'pick'),
    ('someone_else',     'Someone else picked up',             'connected',     null,       'sales', 11, '2h'),
    ('language',         'Language barrier',                   'connected',     null,       'sales', 12, 'none'),
    ('disconnected',     'Disconnected after intro',           'connected',     null,       'sales', 13, '1h'),
    -- Sales · real conversation
    ('interested',       'Interested — needs more info',       'positive',      'interest', 'sales', 20, 'tomorrow'),
    ('deciding',         'Interested — will decide soon',      'positive',      'interest', 'sales', 21, 'pick'),
    ('demo',             'Wants a demo / meeting',             'positive',      null,       'sales', 22, 'pick'),
    ('price',            'Price objection',                    'connected',     null,       'sales', 23, 'tomorrow'),
    ('family',           'Needs to discuss with family',       'connected',     null,       'sales', 24, 'tomorrow'),
    ('payment_link',     'Payment link sent',                  'positive',      null,       'sales', 25, '3h'),
    ('later',            'Not interested now — maybe later',   'connected',     null,       'sales', 26, '30d'),
    ('not_interested',   'Not interested',                     'lost',          null,       'sales', 27, 'none'),
    -- Sales · result
    ('sale_closed',      'Sale closed',                        'won',           'sale',     'sales', 30, 'none'),
    ('already_bought',   'Already bought',                     'lost',          null,       'sales', 31, 'none'),
    -- Sales · bad lead
    ('wrong_number',     'Wrong number',                       'invalid',       null,       'sales', 40, 'none'),
    ('not_right_person', 'Not the right person / didn''t fill the form', 'invalid', null,  'sales', 41, 'none'),
    ('do_not_call',      'Do not call',                        'invalid',       null,       'sales', 42, 'none'),
    -- Webinar reminder calls (owner's sheet: same names and order)
    ('r_guided',         'Guided',                             'positive',      null,       'reminder', 101, 'none'),
    ('r_didnt_pick',     'Didn''t pick',                       'not_connected', null,       'reminder', 102, '1h'),
    ('r_switched_off',   'Switched off',                       'not_connected', null,       'reminder', 103, '2h'),
    ('r_wrong_number',   'Wrong number',                       'invalid',       null,       'reminder', 104, 'none'),
    ('r_incoming_na',    'Incoming calls not available',       'not_connected', null,       'reminder', 105, 'tomorrow'),
    ('r_someone_else',   'Someone else picked',                'connected',     null,       'reminder', 106, '2h'),
    ('r_out_of_service', 'Out of service',                     'not_connected', null,       'reminder', 107, 'none'),
    ('r_repeated',       'Repeated',                           'connected',     null,       'reminder', 108, 'none'),
    ('r_not_reachable',  'Not reachable',                      'not_connected', null,       'reminder', 109, '2h'),
    ('r_disconnected',   'Disconnected after intro',           'connected',     null,       'reminder', 110, '1h'),
    ('r_team',           'Team',                               'invalid',       null,       'reminder', 111, 'none'),
    ('r_call_later',     'Asked to call later',                'connected',     null,       'reminder', 112, 'pick'),
    ('r_busy',           'Busy on another call',               'not_connected', null,       'reminder', 113, '1h'),
    ('r_invalid',        'Invalid number',                     'invalid',       null,       'reminder', 114, 'none'),
    ('r_not_interested', 'Not interested',                     'lost',          null,       'reminder', 115, 'none'),
    ('r_maybe',          'Will try / maybe',                   'connected',     null,       'reminder', 116, '3h'),
    ('r_next_batch',     'Can''t attend — wants next batch',   'connected',     null,       'reminder', 117, 'none'),
    ('r_send_link',      'Asked to send the link',             'connected',     null,       'reminder', 118, 'none')
  ), up as (
    insert into public.call_outcomes (org_id, code, label, category, form, purpose, position, next_default, is_active)
    select p_org, code, label, category::public.outcome_category, form, purpose, pos, nxt, true from v
    on conflict (org_id, code) do update set label = excluded.label, category = excluded.category, form = excluded.form,
      purpose = excluded.purpose, position = excluded.position, next_default = excluded.next_default, is_active = true
    returning code
  )
  -- Old outcomes are hidden, not deleted: past calls keep them.
  update public.call_outcomes set is_active = false where org_id = p_org and code not in (select code from v);
end $function$;

do $$ declare o record; begin
  for o in select id from public.organizations loop perform public.apply_outcome_set_v2(o.id); end loop;
end $$;
