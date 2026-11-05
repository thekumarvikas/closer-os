export type Role = 'owner' | 'admin' | 'manager' | 'rep'

export interface Organization {
  id: string; name: string; country_code: string; phone_prefix: string
  currency: string; timezone: string; date_format: string
  settings: { call_tracking?: 'all' | 'leads'; track_whatsapp?: boolean; note_tags?: string[]; review_criteria?: string[]; app_lead_filters?: string[]; recording_retention_days?: number | null; show_leaderboard?: boolean } & Record<string, unknown>
}
export interface Profile { id: string; email: string | null; full_name: string | null; avatar_url: string | null; phone?: string | null; is_super_admin?: boolean }
/** What the company may do now (org_access()). state: trial | active | grace | expired. */
export interface Access { state: 'trial' | 'active' | 'grace' | 'expired'; status: string; plan: string | null; plan_id: string | null; features: Record<string, boolean>
  seats: number; seats_used: number; cycle: 'month' | 'year' | null; ends_at: string | null; grace_ends_at: string | null; days_left: number | null }
export interface Member { org_id: string; user_id: string; role: Role; status: 'active' | 'deactivated'; joined_at: string; profile?: Profile | null }
export interface Team { id: string; org_id: string; name: string }
export interface TeamMember { team_id: string; user_id: string; org_id: string; is_manager: boolean }
export interface Stage { id: string; name: string; position: number; is_won: boolean; is_lost: boolean; is_active: boolean }
export interface Outcome { id: string; code: string; label: string; category: string; form: string | null; position: number; is_active: boolean; purpose: 'sales' | 'reminder' | 'both'; next_default?: string | null }
export interface Lead {
  id: string; org_id: string; name: string; phone: string; email: string | null
  city: string | null; state: string | null; country: string | null; company: string | null; profession: string | null; profession_category_id: string | null
  source: string | null; campaign: string | null; assigned_to: string | null; assigned_at?: string | null; stage_id: string | null
  deal_value: number | null; tags: string[]; custom: Record<string, unknown>; notes: string | null; key_facts?: string | null
  last_call_at: string | null; last_outcome_id: string | null; next_follow_up_at: string | null
  do_not_call: boolean; created_at: string
  dial_count?: number; conversation_count?: number; total_talk_sec?: number; wa_count?: number
}
export interface Call {
  id: string; lead_id: string | null; user_id: string; direction: 'outgoing' | 'incoming' | 'missed' | 'rejected'
  phone: string; started_at: string; duration_sec: number; sim_slot: number | null; sim_label: string | null
  outcome_id: string | null; outcome_data: Record<string, unknown>; notes: string | null; recording_status: string
}
export interface FollowUp {
  id: string; lead_id: string; assigned_to: string; due_at: string; status: 'pending' | 'done' | 'cancelled'
  priority: number; reason: string | null; notes: string | null
}
export interface Invitation { id: string; email: string; role: Role; team_ids: string[]; expires_at: string; accepted_at: string | null; created_at: string }
export interface Rule {
  id: string; name: string; method: 'manual' | 'round_robin' | 'rule'; conditions: Record<string, string>
  user_ids: string[]; priority: number; is_active: boolean
}
export interface Batch {
  id: string; org_id: string; name: string; webinar_at: string; hot_minutes: number; guided_target_pct: number
  zoom_uploaded_at: string | null; is_archived: boolean; created_at: string; holdout_pct: number; kind?: 'webinar' | 'event' | 'batch'
}
export interface ProfessionCategory { id: string; name: string; keywords: string[]; position: number }
