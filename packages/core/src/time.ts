// Storage is always UTC (timestamptz); display is DISPLAY_TZ (IST by default).
export const DEFAULT_DISPLAY_TZ = "Asia/Kolkata";

export function nowUtc(): Date {
  return new Date();
}

/** Format a Date for humans in the display timezone (dashboard, Telegram). */
export function toDisplay(dt: Date, tz: string = DEFAULT_DISPLAY_TZ): string {
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: tz,
    hour12: true,
  }).format(dt);
}

/** IST wall-clock hour → UTC hour (fractional: IST = UTC+5:30). */
export function istHourToUtc(h: number): number {
  return (((h - 5.5) % 24) + 24) % 24;
}

/** IST is a fixed UTC+5:30 with no DST — scheduling math is exact (doc 06 §4). */
export const IST_OFFSET_MINUTES = 330;
export const IST_WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type IstWeekday = (typeof IST_WEEKDAYS)[number];

export interface IstParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  weekday: IstWeekday;
  hour: number;
  minute: number;
}

/** Read the IST wall-clock calendar parts of a UTC instant. */
export function istParts(utc: Date): IstParts {
  const shifted = new Date(utc.getTime() + IST_OFFSET_MINUTES * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    weekday: IST_WEEKDAYS[shifted.getUTCDay()] as IstWeekday,
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

/** IST wall-clock (calendar day + HH:MM) → the UTC instant it names. */
export function istWallToUtc(
  year: number,
  month: number, // 1-12
  day: number,
  hour: number,
  minute: number,
): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - IST_OFFSET_MINUTES * 60_000);
}

/** Parse 'HH:MM' → {hour, minute}; throws on malformed or out-of-range input. */
export function parseHhMm(s: string): { hour: number; minute: number } {
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) throw new Error(`invalid HH:MM time: ${s}`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) throw new Error(`HH:MM time out of range: ${s}`);
  return { hour, minute };
}
