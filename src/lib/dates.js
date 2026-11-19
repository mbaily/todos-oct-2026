import { dateDisplayOptions } from './model.js';

export function formatEntityDate(entity, mode = 'none') {
  const option = dateDisplayOptions.find(option => option.value === mode);
  if (!option?.field || !entity[option.field]) return '';
  const date = new Date(entity[option.field]);
  if (Number.isNaN(date.getTime())) return '';
  const pad = value => String(value).padStart(2, '0');
  const day = `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return option.time ? `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` : day;
}