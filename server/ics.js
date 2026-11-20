// Reads an iCalendar (.ics) file, as published by Outlook, Google Calendar, Apple Calendar, etc.
// Returns simple events in the venue's local time. Read-only: nothing is written back to the calendar.

function unfold(text) {
  return text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
}
const unescapeText = v => v.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();

// Offset in minutes of a time zone at a given moment (handles daylight saving)
function zoneOffsetMinutes(epochMs, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(new Date(epochMs));
  const p = Object.fromEntries(parts.filter(x => x.type !== 'literal').map(x => [x.type, Number(x.value)]));
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return (asUTC - epochMs) / 60000;
}
function zonedToEpoch(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const off1 = zoneOffsetMinutes(guess, tz);
  const ep = guess - off1 * 60000;
  const off2 = zoneOffsetMinutes(ep, tz);
  return off1 === off2 ? ep : guess - off2 * 60000;
}

// "20261120T100000Z", "20261120T100000" with TZID, or floating (treated as venue time)
function parseDateValue(value, params, appTz) {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;   // all-day dates (no time) are skipped
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  let epoch;
  if (m[7] === 'Z') epoch = Date.UTC(y, mo - 1, d, h, mi, s);
  else {
    let tz = params.TZID || appTz;
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch (_) { tz = appTz; }
    epoch = zonedToEpoch(y, mo, d, h, mi, s, tz);
  }
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: appTz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).format(new Date(epoch)).replace('T', ' ');
}

function parseIcs(text, appTz) {
  const events = [];
  let cur = null;
  for (const line of unfold(String(text))) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') {
      if (cur && cur.start && cur.status !== 'CANCELLED') {
        events.push({ uid: cur.uid || '', title: cur.summary || 'Busy', location: cur.location || '',
          start_at: cur.start, end_at: cur.end || addHour(cur.start) });
      }
      cur = null; continue;
    }
    if (!cur) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const [name, ...paramParts] = line.slice(0, colon).split(';');
    const value = line.slice(colon + 1);
    const params = Object.fromEntries(paramParts.map(p => p.split('=')).map(([k, v]) => [k.toUpperCase(), v]));
    switch (name.toUpperCase()) {
      case 'UID': cur.uid = value; break;
      case 'SUMMARY': cur.summary = unescapeText(value); break;
      case 'LOCATION': cur.location = unescapeText(value); break;
      case 'STATUS': cur.status = value.toUpperCase(); break;
      case 'DTSTART': cur.startRaw = value; cur.start = parseDateValue(value, params, appTz); break;
      case 'DTEND': cur.end = parseDateValue(value, params, appTz); break;
    }
  }
  return events.filter(e => e.start_at && e.end_at && e.end_at > e.start_at);
}
function addHour(venueStr) {
  const [date, time] = venueStr.split(' ');
  const [h, mi, s] = time.split(':').map(Number);
  const d = new Date(Date.UTC(...date.split('-').map((v, i) => i === 1 ? Number(v) - 1 : Number(v)), h + 1, mi, s));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

module.exports = { parseIcs };
