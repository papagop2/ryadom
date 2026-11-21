export type ScheduleDay = {
  weekday: number;
  isClosed: boolean;
  is24h: boolean;
  intervals: { from: string; to: string }[];
  present?: boolean;
};
export type OpenState = {
  state: 'open' | 'closed' | 'unknown';
  label: string | null;
  opensAt: string | null;
  closesAt: string | null;
  weekday: number | null;
  is24h?: boolean;
};
export function openStateFromDays(days: ScheduleDay[], timezone?: string, now?: Date): OpenState;
export function validateSchedule(days: unknown): ScheduleDay[] | null;
