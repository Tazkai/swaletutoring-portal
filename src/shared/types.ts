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
// Non-attendance statuses arrive in slice 2.
export const ATTENDED_STATUSES = ['present', 'late', 'left_early'] as const;
export type AttendedStatus = (typeof ATTENDED_STATUSES)[number];

export const ENGAGEMENT_LABELS: Record<1 | 2 | 3, string> = {
  1: 'Excellent',
  2: 'OK',
  3: 'Poor',
};

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
  next_lesson?: string;
  problems?: string;
  engagement: 1 | 2 | 3;
  issues?: string;
  needs_followup?: boolean;
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
