-- Owner's leads include many engineers of different fields: separate "Engineering" group instead of
-- lumping every "engineer" into IT & Software. Software/IT engineers stay in IT (matched first).
create or replace function public.seed_org_defaults(p_org uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profession_categories (org_id, name, position, keywords) values
    (p_org, 'Finance & Insurance', 1, array['insurance','lic','ca','chartered accountant','accountant','accounts','loan','loans','finance','financial','banking','bank','banker','mutual fund','mutual funds','tax','gst','investment','investor','stock','stocks','share market','wealth','nbfc','credit']),
    (p_org, 'Digital Marketing Agency', 2, array['digital marketing','performance marketing','seo','gmb','google my business','social media','smm','marketing agency','agency','meta ads','facebook ads','google ads','lead generation','branding']),
    (p_org, 'Real Estate', 3, array['real estate','property','properties','builder','broker','realtor','construction','developer real estate']),
    (p_org, 'Education & Coaching', 4, array['teacher','tutor','tuition','coach','coaching','trainer','training','education','school','professor','lecturer','institute','academy','edtech']),
    (p_org, 'Healthcare & Wellness', 5, array['doctor','dr','dentist','physiotherapist','physio','nurse','clinic','hospital','pharma','pharmacist','chemist','nutritionist','dietitian','psychologist','therapist','yoga','fitness','gym','wellness']),
    (p_org, 'IT & Software', 6, array['software','developer','programmer','it','web developer','app developer','tech','data','saas','software engineer','coder','it engineer','computer engineer']),
    (p_org, 'Engineering', 7, array['engineer','engineering','civil','mechanical','electrical','electronics','architect','site engineer','technician','diploma','b.tech','btech','automobile']),
    (p_org, 'E-commerce & D2C', 7, array['ecommerce','e-commerce','amazon','flipkart','meesho','shopify','d2c','online store','dropshipping','online selling','seller']),
    (p_org, 'Retail & Trading Business', 8, array['shop','shop owner','retail','retailer','store','wholesaler','wholesale','distributor','dealer','kirana','trader','trading business']),
    (p_org, 'Manufacturing', 9, array['manufacturer','manufacturing','factory','production','industry','industrial','plant']),
    (p_org, 'Freelancer & Creator', 10, array['freelancer','freelance','designer','graphic designer','content creator','creator','youtuber','influencer','photographer','video editor','editor','writer','copywriter']),
    (p_org, 'Consulting & Legal', 11, array['consultant','consulting','consultancy','lawyer','advocate','legal','hr consultant']),
    (p_org, 'Salaried Professional', 12, array['job','salaried','employee','working professional','corporate','manager','executive','service','private job','government job','govt job']),
    (p_org, 'Business Owner', 13, array['business','business owner','businessman','entrepreneur','startup','founder','owner','self employed','self-employed']),
    (p_org, 'Student', 14, array['student','college','fresher','graduate','studying']),
    (p_org, 'Homemaker', 15, array['homemaker','housewife','home maker','house wife'])
  on conflict (org_id, name) do nothing;

  insert into public.call_outcomes (org_id, code, label, category, purpose, position) values
    (p_org, 'r_guided',          'Guided',                     'positive',      'reminder', 101),
    (p_org, 'r_didnt_pick',      'Didn''t pick',               'not_connected', 'reminder', 102),
    (p_org, 'r_switched_off',    'Switched off',               'not_connected', 'reminder', 103),
    (p_org, 'r_wrong_number',    'Wrong number',               'invalid',       'reminder', 104),
    (p_org, 'r_incoming_na',     'Incoming calls not available','not_connected','reminder', 105),
    (p_org, 'r_someone_else',    'Someone else picked',        'connected',     'reminder', 106),
    (p_org, 'r_out_of_service',  'Out of service',             'not_connected', 'reminder', 107),
    (p_org, 'r_not_reachable',   'Not reachable',              'not_connected', 'reminder', 108),
    (p_org, 'r_disconnected',    'Disconnected after intro',   'connected',     'reminder', 109),
    (p_org, 'r_call_later',      'Asked to call later',        'connected',     'reminder', 110),
    (p_org, 'r_busy',            'Busy on another call',       'not_connected', 'reminder', 111),
    (p_org, 'r_invalid',         'Invalid number',             'invalid',       'reminder', 112),
    (p_org, 'r_not_interested',  'Not interested',             'lost',          'reminder', 113)
  on conflict (org_id, code) do nothing;
end $$;

-- Existing companies: add the group (right after IT), narrow IT's keywords, regroup affected leads.
update public.profession_categories set keywords = array_remove(keywords, 'engineer') || array['software engineer','it engineer','computer engineer']
where name = 'IT & Software' and 'engineer' = any(keywords);
update public.profession_categories c set position = position + 1
where position >= 7 and not exists (select 1 from public.profession_categories x where x.org_id = c.org_id and x.name = 'Engineering');
insert into public.profession_categories (org_id, name, position, keywords)
select o.id, 'Engineering', 7, array['engineer','engineering','civil','mechanical','electrical','electronics','architect','site engineer','technician','diploma','b.tech','btech','automobile']
from public.organizations o on conflict (org_id, name) do nothing;
update public.leads l set profession_category_id = coalesce(public.categorize_profession(l.org_id, l.profession), l.profession_category_id)
where l.profession is not null and l.profession_category_id in (select id from public.profession_categories where name = 'IT & Software');
