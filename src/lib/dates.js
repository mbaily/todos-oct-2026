import { dateDisplayOptions } from './model.js';

const pad = value => String(value).padStart(2, '0');
const weekdayPattern = '(?:(?<weekday>Sun(?:day)?|Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?)(?<gap>,?\\s+))?';
const yearFirst = new RegExp(`\\b${weekdayPattern}(?<year>\\d{4})(?<sep>[-/.])(?<month>\\d{1,2})\\k<sep>(?<day>\\d{1,2})\\b`, 'i');
const dayFirst = new RegExp(`\\b${weekdayPattern}(?<day>\\d{1,2})(?<sep>[-/.])(?<month>\\d{1,2})(?:\\k<sep>(?<year>\\d{4}|\\d{2}))?\\b`, 'i');

export function formatListDate(date) {
  return [pad(date.getDate()), pad(date.getMonth() + 1), String(date.getFullYear()).padStart(4, '0')].join('/');
}

function localDate(year, month, day) {
  const date = new Date(0);
  date.setHours(12, 0, 0, 0);
  date.setFullYear(year, month - 1, day);
  return date;
}

export function nextListName(name, { days = 1, pickedDate, today = new Date() } = {}) {
  const isoMatch = name.match(yearFirst);
  const match = isoMatch ?? name.match(dayFirst);
  const parts = match?.groups;
  let sourceDate = today;
  let hasNamedDate = false;
  if (parts) {
    const year = parts.year ? Number(parts.year) + (parts.year.length === 2 ? 2000 : 0) : today.getFullYear();
    const date = localDate(year, Number(parts.month), Number(parts.day));
    hasNamedDate = date.getMonth() + 1 === Number(parts.month) && date.getDate() === Number(parts.day);
    if (hasNamedDate) sourceDate = date;
  }
  const date = pickedDate
    ? localDate(...pickedDate.split('-').map(Number))
    : localDate(sourceDate.getFullYear(), sourceDate.getMonth() + 1, sourceDate.getDate() + days);
  if (!hasNamedDate) return formatListDate(date);

  const year = String(date.getFullYear()).padStart(4, '0');
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const dateParts = isoMatch ? [year, month, day] : [day, month];
  if (dateParts.length === 2 && parts.year) dateParts.push(year.slice(-parts.year.length));
  const weekday = parts.weekday
    ? new Intl.DateTimeFormat('en', { weekday: parts.weekday.length === 3 ? 'short' : 'long' }).format(date) + parts.gap
    : '';
  return name.slice(0, match.index) + weekday + dateParts.join(parts.sep) + name.slice(match.index + match[0].length);
}

export function formatEntityDate(entity, mode = 'none') {
  const option = dateDisplayOptions.find(option => option.value === mode);
  if (!option?.field || !entity[option.field]) return '';
  const date = new Date(entity[option.field]);
  if (Number.isNaN(date.getTime())) return '';
  const day = `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return option.time ? `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` : day;
}
