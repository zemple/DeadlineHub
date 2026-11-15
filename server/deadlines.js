import { casual } from 'chrono-node';

export const campusZone = 'America/Chicago';
export const kinds = ['assignment', 'exam', 'project', 'other'];
export const maxDeadlines = 100;

const campusFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: campusZone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function campusDateTime(now) {
  const parts = Object.fromEntries(campusFormatter.formatToParts(now).map(({ type, value }) => [type, value]));
  return {
    date: parts.year + '-' + parts.month + '-' + parts.day,
    time: parts.hour + ':' + parts.minute,
  };
}

export function normalizeCourse(input) {
  const match = typeof input === 'string' && input.trim().match(/^([a-z][a-z&]{0,11})\s*(\d{3}[a-z]?)$/i);
  if (!match) throw new RequestError(400, 'Enter a course code such as CS 409.');
  return (match[1] + ' ' + match[2]).toUpperCase();
}

function isRealDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function validateDeadline(input) {
  if (!input || typeof input.title !== 'string' || !input.title.trim() || input.title.trim().length > 160) {
    throw new RequestError(400, 'Every deadline needs a title of 1 to 160 characters.');
  }
  if (!kinds.includes(input.kind)) throw new RequestError(400, 'Choose a valid deadline type.');
  if (!isRealDate(input.date)) throw new RequestError(400, 'Enter a valid date for each deadline.');
  const time = input.time === '' ? null : input.time;
  if (time !== null && (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))) {
    throw new RequestError(400, 'Enter a valid time or leave it blank.');
  }
  return { course: normalizeCourse(input.course), title: input.title.trim(), kind: input.kind, date: input.date, time };
}

export function parseQuickAdd(input, now = new Date()) {
  const match = typeof input === 'string' && input.length <= 400 &&
    input.trim().match(/^([a-z][a-z&]{0,11}\s*\d{3}[a-z]?)\s+(.+?)\s+due\s+(.+)$/i);
  if (!match) throw new RequestError(400, 'Include the course, title and due date. Example: CS 409 MP due next Friday 11:59pm.');

  const [, course, title, phrase] = match;
  const { date, time } = campusDateTime(now);
  // Supply Chicago wall time as a UTC reference so parsing is independent of the server's timezone.
  const reference = new Date(date + 'T' + time + ':00Z');
  const results = casual.parse(phrase, { instant: reference, timezone: 0 }, { forwardDate: true });
  const result = results[0];
  if (results.length !== 1 || result.text !== phrase || result.end ||
      (!result.start.isCertain('day') && !result.start.isCertain('weekday'))) {
    throw new RequestError(400, 'Use a single due date, such as tomorrow, next Friday at 5pm, or 2026-12-04.');
  }
  if (result.start.isCertain('timezoneOffset')) {
    throw new RequestError(400, 'Enter the date and time in Central Time without a timezone suffix.');
  }

  const pad = (number) => String(number).padStart(2, '0');
  const resolvedDate = [String(result.start.get('year')).padStart(4, '0'), pad(result.start.get('month')), pad(result.start.get('day'))].join('-');
  const resolvedTime = result.start.isCertain('hour')
    ? pad(result.start.get('hour')) + ':' + pad(result.start.get('minute'))
    : null;
  let kind = 'assignment';
  if (/\b(exam|midterm)\b/i.test(title)) kind = 'exam';
  else if (/\bproject\b/i.test(title)) kind = 'project';
  return validateDeadline({ course, title, kind, date: resolvedDate, time: resolvedTime });
}

export function getSampleDeadlines(now) {
  const { date } = campusDateTime(now);
  const nextDate = (days) => new Date(Date.parse(date) + days * 86_400_000).toISOString().slice(0, 10);
  return [
    { course: 'CS 409', title: 'MP 4: React application', kind: 'assignment', date: nextDate(4), time: '23:59' },
    { course: 'CS 409', title: 'Final project prototype', kind: 'project', date: nextDate(8), time: '17:00' },
    { course: 'CS 409', title: 'Final exam', kind: 'exam', date: nextDate(14), time: '13:30' },
  ];
}
