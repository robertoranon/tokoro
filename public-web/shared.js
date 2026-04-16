'use strict';

/**
 * Format a Date as "YYYY-MM-DDTHH:MM:SS" in local time.
 * @param {Date} date
 * @returns {string}
 */
function formatLocalDateTime(date) {
  const pad = n => String(n).padStart(2, '0');
  return (
    date.getFullYear() +
    '-' + pad(date.getMonth() + 1) +
    '-' + pad(date.getDate()) +
    'T' + pad(date.getHours()) +
    ':' + pad(date.getMinutes()) +
    ':' + pad(date.getSeconds())
  );
}

/**
 * Format an event date/time range into a human-readable string.
 * Handles ISO 8601 strings with or without time components, and Unix timestamps.
 * @param {string|number|null} sv - start value
 * @param {string|number|null} ev - end value
 * @returns {string}
 */
function fmtRange(sv, ev) {
  const sht = typeof sv === 'string' ? sv.includes('T') : typeof sv === 'number';
  const eht = typeof ev === 'string' ? ev.includes('T') : typeof ev === 'number';
  function pv(v) {
    if (!v) return null;
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) v = v + 'T12:00:00';
    const d = typeof v === 'number' ? new Date(v * 1000) : new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  const s = pv(sv);
  if (!s) return 'Date not specified';
  const e = pv(ev);
  const dp = d =>
    String(d.getDate()).padStart(2, '0') + '.' +
    String(d.getMonth() + 1).padStart(2, '0') + '.' +
    d.getFullYear();
  const ds = d =>
    String(d.getDate()).padStart(2, '0') + '.' +
    String(d.getMonth() + 1).padStart(2, '0');
  const tp = d => {
    const h = d.getHours(), m = d.getMinutes(), ap = h >= 12 ? 'pm' : 'am', h12 = h % 12 || 12;
    return m ? h12 + ':' + String(m).padStart(2, '0') + ap : h12 + ap;
  };
  if (!e) return sht ? dp(s) + ' ' + tp(s) : dp(s);
  const sd =
    s.getFullYear() === e.getFullYear() &&
    s.getMonth() === e.getMonth() &&
    s.getDate() === e.getDate();
  if (sd) {
    if (!sht) return dp(s);
    return eht ? dp(s) + ' ' + tp(s) + '\u2013' + tp(e) : dp(s) + ' ' + tp(s);
  }
  const overnight = e.getHours() < 12 && e - s < 24 * 3600 * 1000;
  if (overnight) return dp(s) + ' ' + tp(s) + '\u2013' + tp(e);
  if (s.getFullYear() === e.getFullYear()) return ds(s) + '\u2013' + dp(e);
  return dp(s) + '\u2013' + dp(e);
}

/**
 * Escape HTML special characters.
 * @param {*} s
 * @returns {string}
 */
function escHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Return s if it is a safe http(s) URL, otherwise null.
 * @param {*} s
 * @returns {string|null}
 */
function safeUrl(s) {
  if (!s) return null;
  const str = String(s);
  return /^https?:\/\//i.test(str) ? str : null;
}

/**
 * Build a Tokoro /events query URL.
 * @param {string} apiBase - Base API URL, no trailing slash
 * @param {{ lat: string|number, lng: string|number, radius: string|number, from: string, to: string, category?: string, tags?: string }} params
 * @returns {string}
 */
function buildQueryUrl(apiBase, { lat, lng, radius, from, to, category, tags }) {
  let url =
    apiBase + '/events' +
    '?lat=' + encodeURIComponent(lat) +
    '&lng=' + encodeURIComponent(lng) +
    '&radius=' + encodeURIComponent(radius) +
    '&from=' + encodeURIComponent(from) +
    '&to=' + encodeURIComponent(to);
  if (category) url += '&category=' + encodeURIComponent(category);
  if (tags) url += '&tags=' + encodeURIComponent(tags);
  return url;
}

/**
 * Geocode a free-text address via OpenStreetMap Nominatim.
 * @param {string} address
 * @returns {Promise<{ lat: string, lng: string, displayName: string }>}
 * @throws {Error} if the address is not found or the request fails
 */
async function geocode(address) {
  const resp = await fetch(
    'https://nominatim.openstreetmap.org/search?q=' +
      encodeURIComponent(address) +
      '&format=json&limit=1',
    { headers: { 'User-Agent': 'Tokoro App' } }
  );
  if (!resp.ok) throw new Error(`Geocoding request failed: ${resp.status}`);
  const data = await resp.json();
  if (!data || data.length === 0) throw new Error('Address not found');
  return {
    lat: parseFloat(data[0].lat).toFixed(4),
    lng: parseFloat(data[0].lon).toFixed(4),
    displayName: data[0].display_name,
  };
}

// Node.js / browser compatibility
if (typeof module !== 'undefined') {
  module.exports = { formatLocalDateTime, fmtRange, escHtml, safeUrl, buildQueryUrl, geocode };
}
if (typeof window !== 'undefined') {
  window.formatLocalDateTime = formatLocalDateTime;
  window.fmtRange = fmtRange;
  window.escHtml = escHtml;
  window.safeUrl = safeUrl;
  window.buildQueryUrl = buildQueryUrl;
  window.geocode = geocode;
}
