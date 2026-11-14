'use strict';

const TZ = process.env.APP_TZ || 'Asia/Kolkata';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Local date ('YYYY-MM-DD'), minutes since midnight and weekday (0=Sun) in the app time zone. */
function localParts(d, tz = TZ) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  });
  const p = {};
  for (const part of f.formatToParts(d)) p[part.type] = part.value;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
    weekday: WEEKDAYS[p.weekday],
  };
}

function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** 'HH:MM' -> minutes, or null if invalid */
function hmToMin(s) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(s));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function minToHm(n) {
  return String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');
}

function normalizePhone(p) {
  const s = String(p || '').replace(/[\s\-()]/g, '');
  return /^\+?\d{10,15}$/.test(s) ? s : null;
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

/** Required trimmed string with length limits. */
function reqStr(body, key, label, min = 1, max = 200) {
  const v = typeof body?.[key] === 'string' ? body[key].trim() : '';
  if (v.length < min) throw new HttpError(400, `${label} is required`);
  if (v.length > max) throw new HttpError(400, `${label} is too long (max ${max} characters)`);
  return v;
}

/** Optional trimmed string (empty -> null). */
function optStr(body, key, label, max = 200) {
  const raw = body?.[key];
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string') throw new HttpError(400, `${label} must be text`);
  const v = raw.trim();
  if (v.length > max) throw new HttpError(400, `${label} is too long (max ${max} characters)`);
  return v || null;
}

function reqInt(body, key, label, min, max) {
  const v = Number(body?.[key]);
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new HttpError(400, `${label} must be a whole number between ${min} and ${max}`);
  }
  return v;
}

function idParam(req, name = 'id') {
  const v = Number(req.params[name]);
  if (!Number.isInteger(v) || v <= 0) throw new HttpError(404, 'Not found');
  return v;
}

module.exports = {
  TZ,
  HttpError,
  localParts,
  isValidDate,
  weekdayOf,
  addDays,
  hmToMin,
  minToHm,
  normalizePhone,
  haversineKm,
  reqStr,
  optStr,
  reqInt,
  idParam,
};
