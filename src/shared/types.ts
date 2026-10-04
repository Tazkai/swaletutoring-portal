// Types and constants shared between the server and the phone app.

export const ROLES = ['tutor', 'dsl', 'deputy', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export const VENUES = ['home', 'community', 'school', 'online'] as const;
export type Venue = (typeof VENUES)[number];

export const VENUE_LABELS: Record<Venue, string> = {
  home: 'Home',
  community: 'Community venue',
  school: 'School room',
  online: 'Online',
};

// Statuses a tutor can set on a session the pupil attended.
export const ATTENDED_STATUSES = ['present', 'late', 'left_early'] as const;
export type AttendedStatus = (typeof ATTENDED_STATUSES)[number];

export const NON_ATTENDANCE_STATUSES = [
  'sick_called_in',
  'cancelled_family',
  'cancelled_school',
  'cancelled_us',
  'no_show',
] as const;
export type NonAttendanceStatus = (typeof NON_ATTENDANCE_STATUSES)[number];

export const NON_ATTENDANCE_LABELS: Record<NonAttendanceStatus, string> = {
  sick_called_in: 'Ill (called in)',
  cancelled_family: 'Cancelled by family',
  cancelled_school: 'Cancelled by school',
  cancelled_us: 'Cancelled by us',
  no_show: 'No-show',
};

// Someone told us about these, so we record who.
export const REPORTED_STATUSES: readonly NonAttendanceStatus[] = [
  'sick_called_in',
  'cancelled_family',
  'cancelled_school',
];

export const ENGAGEMENT_LABELS: Record<1 | 2 | 3, string> = {
  1: 'Excellent',
  2: 'OK',
  3: 'Poor',
};

// ---------- back office (09_IT_Systems/Back_Office_Scope.md) ----------

export const FUNDING_ROUTES = ['ehcp', 'eotas', 'spot_purchase', 'route_b_package', 'other'] as const;
export const FUNDING_ROUTE_LABELS: Record<(typeof FUNDING_ROUTES)[number], string> = {
  ehcp: 'EHCP',
  eotas: 'EOTAS',
  spot_purchase: 'Spot purchase',
  route_b_package: 'Route B package',
  other: 'Other',
};

// Every pupil column the office may edit.
export const OFFICE_PUPIL_FIELDS = [
  'first_name', 'last_name', 'preferred_name', 'pronouns', 'date_of_birth', 'year_group',
  'commissioner', 'commissioner_ref', 'funding_route', 'caseworker_name', 'caseworker_email',
  'caseworker_phone', 'kcc_urn', 'po_number', 'school_name', 'senco_name', 'senco_contact',
  'hours_per_week', 'delivery_mode', 'ehcp', 'ehcp_reference', 'looked_after', 'vsk_lot3',
  'primary_presentation', 'office_notes', 'status', 'start_date', 'end_date',
] as const;

// What the assigned tutor must know before working with the pupil (Key Information Document).
export const KEY_INFO_FIELDS = [
  'address', 'access_notes', 'household', 'allergies', 'medication', 'medical_plan',
  'sensory_needs', 'triggers', 'what_helps', 'what_not_to_do', 'de_escalation', 'risks',
] as const;
export type KeyInfoField = (typeof KEY_INFO_FIELDS)[number];

export const KEY_INFO_LABELS: Record<KeyInfoField, string> = {
  address: 'Address',
  access_notes: 'Access and parking',
  household: 'Who else is in the home (adults, siblings, pets)',
  allergies: 'Allergies',
  medication: 'Medication',
  medical_plan: 'Medical / first-aid plan',
  sensory_needs: 'Sensory needs',
  triggers: 'Triggers',
  what_helps: 'What helps',
  what_not_to_do: 'What NOT to do',
  de_escalation: 'De-escalation',
  risks: 'Home-visit and lone-working risks',
};

export const DOCUMENT_CATEGORIES = [
  'ehcp', 'annual_review', 'risk_assessment', 'safeguarding', 'professional_report',
  'agreement', 'referral', 'other',
] as const;
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];
export const DOCUMENT_CATEGORY_LABELS: Record<DocumentCategory, string> = {
  ehcp: 'EHCP',
  annual_review: 'Annual review',
  risk_assessment: 'Risk assessment',
  safeguarding: 'Safeguarding',
  professional_report: 'Professional report (EP, CAMHS, OT, SaLT)',
  agreement: 'Signed agreement',
  referral: 'Referral',
  other: 'Other',
};

export interface KeyInfoView {
  version: number;
  fields: Partial<Record<KeyInfoField, string | null>>;
  confirmed_at: string | null;
  first_aider_required: boolean;
  targets: { id: number; ehcp_outcome: string | null; target: string; measure: string | null; review_date: string | null }[];
}

export interface Me {
  user: { id: number; email: string; display_name: string; role: Role };
  dsl_phone: string;
}

export interface PupilSummary {
  id: number;
  reference: string;
  first_name: string;
  last_name: string;
  last_venue: Venue | null;
  done_today: 0 | 1;
  preferred_name: string | null;
  first_aider_required: 0 | 1;
  key_info_version: number | null; // null = no key information entered yet
  key_info_confirmed: 0 | 1; // this tutor has confirmed the current version
}

export interface StartSessionBody {
  client_uuid: string;
  pupil_id: number;
  venue: Venue;
  started_at: string;
}

export interface EndSessionBody {
  ended_at: string;
}

export interface LessonRecordBody {
  started_at?: string;
  ended_at?: string;
  attendance_status?: AttendedStatus;
  lesson_summary: string;
  planned_lesson: boolean;
  substitution_reason?: string;
  next_lesson: string;
  problems: string;
  engagement: 1 | 2 | 3;
  issues: string;
  needs_followup?: boolean;
}

export interface NonAttendanceBody {
  client_uuid: string;
  pupil_id: number;
  session_date: string; // YYYY-MM-DD
  attendance_status: NonAttendanceStatus;
  reported_by?: string;
  reported_at?: string;
  note?: string;
}

export interface SessionView {
  client_uuid: string;
  pupil_id: number;
  pupil_name: string;
  session_date: string;
  started_at: string | null;
  ended_at: string | null;
  venue: Venue | null;
  attendance_status: string;
  submitted_at: string | null;
}
