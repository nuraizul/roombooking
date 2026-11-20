const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const crypto = require('crypto');
const { parseIcs } = require('./ics');
const db = require('./db');
const auth = require('./auth');

// Per-device display options (null = use the default from Settings)
{
  const cols = db.prepare('PRAGMA table_info(devices)').all().map(c => c.name);
  if (!cols.includes('layout')) db.exec('ALTER TABLE devices ADD COLUMN layout TEXT');
  if (!cols.includes('template')) db.exec('ALTER TABLE devices ADD COLUMN template TEXT');
}
{
  const bcols = db.prepare('PRAGMA table_info(bookings)').all().map(c => c.name);
  if (!bcols.includes('reject_reason')) db.exec('ALTER TABLE bookings ADD COLUMN reject_reason TEXT');
}
// Floor plan: each room's position on its level (units on a 1000 x 600 canvas), plus named levels
{
  const rc = db.prepare('PRAGMA table_info(rooms)').all().map(c => c.name);
  for (const c of ['map_x', 'map_y', 'map_w', 'map_h']) if (!rc.includes(c)) db.exec(`ALTER TABLE rooms ADD COLUMN ${c} INTEGER`);
  db.exec('CREATE TABLE IF NOT EXISTS floor_levels (name TEXT PRIMARY KEY, sort INTEGER DEFAULT 0)');
}
// Integrations (Microsoft Teams). Kept out of /api/settings because they hold secrets.
db.exec('CREATE TABLE IF NOT EXISTS integrations (key TEXT PRIMARY KEY, value TEXT)');
const intGet = k => db.prepare('SELECT value FROM integrations WHERE key=?').get(k)?.value ?? null;
const intSet = (k, v) => db.prepare('INSERT INTO integrations(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, v);
const teamsOn = () => intGet('teams_enabled') === '1';
const sha256 = v => crypto.createHash('sha256').update(String(v)).digest('hex');
// Statuses that do not hold the room
const FREE_STATUSES = "('Cancelled','Rejected')";
const displayOptionsInput = b => {
  const layout = b.layout === undefined || b.layout === '' || b.layout === null ? null : String(b.layout);
  const template = b.template === undefined || b.template === '' || b.template === null ? null : String(b.template);
  if (layout && !LAYOUTS.includes(layout)) return { error: 'Layout must be landscape or portrait' };
  if (template && !TEMPLATES.includes(template)) return { error: 'Unknown design' };
  return { value: { layout, template } };
};
const effectiveDisplay = (device, s) => ({
  layout: device.layout || s.default_layout,
  template: device.template || s.default_template
});

const PORT = process.env.PORT || 3000;
const ONLINE_WINDOW_MIN = 2;
const ROLES = ['Administrator', 'Staff'];
const LAYOUTS = ['landscape', 'portrait'];
const TEMPLATES = ['classic', 'minimal', 'bold'];
const DEFAULT_SETTINGS = {
  default_layout: 'landscape',
  default_template: 'classic',
  system_name: 'RoomFlow Booking System',
  organization: 'Your Organization',
  time_format: '12',
  default_duration: 60,
  buffer_minutes: 0,
  allow_same_day: true,
  require_approval: false,
  display_refresh_seconds: 30
};

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.json({ limit: '100kb' }));
app.use('/api', auth.requireAccess);
app.use(express.static(path.join(__dirname, '..', 'public')));

const seedSetting = db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) seedSetting.run(k, JSON.stringify(v));

// ---------- time helpers: bookings are stored as local "YYYY-MM-DD HH:MM:SS" so string compare works
const pad = n => String(n).padStart(2, '0');
const fmtLocal = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
// Status is decided by this clock. Force the venue timezone so it does not depend on the host (Railway runs in UTC).
const APP_TZ = process.env.APP_TZ || 'Asia/Kuala_Lumpur';
const nowStr = () => new Intl.DateTimeFormat('sv-SE', {
  timeZone: APP_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
}).format(new Date()).replace('T', ' ');
const todayStr = () => nowStr().slice(0, 10);
const parseLocal = s => new Date(s.replace(' ', 'T'));
const addMin = (s, m) => fmtLocal(new Date(parseLocal(s).getTime() + m * 60000));
const addDays = (date, n) => { const d = new Date(date + 'T00:00:00'); d.setDate(d.getDate() + n); return fmtLocal(d).slice(0, 10); };
const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const bad = (res, error, code = 400) => res.status(code).json({ error });
const isUnique = e => !!e && /UNIQUE/.test(e.message);
function normDateTime(v) {
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const s = `${m[1]} ${m[2]}:${m[3]}:${m[4] || '00'}`;
  return isNaN(parseLocal(s)) ? null : s;
}

// ---------- settings
function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const r of db.prepare('SELECT key,value FROM settings').all()) {
    if (r.key in DEFAULT_SETTINGS) out[r.key] = JSON.parse(r.value);
  }
  return out;
}

// ---------- shapes
const roomShape = r => r && ({ ...r, facilities: JSON.parse(r.facilities || '[]'), active: !!r.active });
const BOOKING_SQL = 'SELECT b.*, r.room_no, r.name AS room_name FROM bookings b JOIN rooms r ON r.id=b.room_id';
function bookingShape(b, now = nowStr()) {
  let time_state;
  if (b.status === 'Cancelled') time_state = 'Cancelled';
  else if (b.status === 'Rejected') time_state = 'Rejected';
  else if (b.end_at <= now) time_state = 'Completed';
  else if (b.start_at <= now) time_state = 'Ongoing';
  else time_state = 'Upcoming';
  return { ...b, time_state };
}
const getBooking = id => bookingShape(db.prepare(`${BOOKING_SQL} WHERE b.id=?`).get(id));

// ---------- approval: enabled in Settings, and only for bookings made by the chosen roles
// Roles that hold "Approve pending bookings" book without waiting; everyone else waits when approval is on.
function bookingStatusFor(role, s) {
  const canApprove = auth.permsFor(role).includes('bookings.approve');
  return s.require_approval && !canApprove ? 'Pending' : 'Confirmed';
}

// ---------- booking rules
function findConflict(room_id, start, end, excludeId, buffer) {
  const from = addMin(start, -buffer), to = addMin(end, buffer);
  return db.prepare(`SELECT id,title,start_at,end_at FROM bookings
    WHERE room_id=? AND status NOT IN ${FREE_STATUSES} AND id!=? AND start_at<? AND end_at>? LIMIT 1`)
    .get(room_id, excludeId || 0, to, from);
}
function validateBooking(body, id = null) {
  const room_id = Number(body.room_id);
  const title = String(body.title || '').trim();
  const organizer = String(body.organizer || '').trim();
  const start = normDateTime(body.start_at), end = normDateTime(body.end_at);
  if (!room_id || !title || !organizer || !start || !end) return { error: 'room_id, title, organizer, start_at and end_at are required' };
  if (title.length > 120 || organizer.length > 80) return { error: 'Title or organizer is too long' };
  const mins = (parseLocal(end) - parseLocal(start)) / 60000;
  if (mins <= 0) return { error: 'End time must be after start time' };
  if (mins < 5) return { error: 'A booking must be at least 5 minutes' };
  if (mins > 720) return { error: 'A booking cannot be longer than 12 hours' };
  const s = getSettings(), now = nowStr();
  if (!id && start < now) return { error: 'Cannot book a time in the past' };
  if (id && end <= now) return { error: 'This booking has already ended' };
  if (!s.allow_same_day && start.slice(0, 10) <= todayStr()) return { error: 'Same-day bookings are not allowed' };
  if (!db.prepare('SELECT id FROM rooms WHERE id=? AND active=1').get(room_id)) return { error: 'Room not found' };
  const c = findConflict(room_id, start, end, id, s.buffer_minutes);
  if (c) return { error: `Room is already booked ${c.start_at.slice(11, 16)}–${c.end_at.slice(11, 16)} (${c.title})`, conflict: true };
  return { value: { room_id, title, organizer, start_at: start, end_at: end } };
}
function broadcastBooking(type, booking, oldRoomId) {
  io.to(`room:${booking.room_id}`).emit('booking:changed', { type });
  if (oldRoomId && oldRoomId !== booking.room_id) io.to(`room:${oldRoomId}`).emit('booking:changed', { type });
  io.emit('bookings:changed', { type });
}

// ---------- rooms with live status
function roomsWithStatus() {
  const now = nowStr();
  const rooms = db.prepare('SELECT * FROM rooms WHERE active=1 ORDER BY room_no').all().map(roomShape);
  const upcoming = db.prepare(`${BOOKING_SQL} WHERE b.status NOT IN ${FREE_STATUSES} AND b.end_at>? AND r.active=1 ORDER BY b.start_at`)
    .all(now).map(b => bookingShape(b, now));
  return rooms.map(room => {
    const mine = upcoming.filter(b => b.room_id === room.id);
    const current = mine.find(b => b.time_state === 'Ongoing') || null;
    const next = mine.find(b => b.time_state === 'Upcoming') || null;
    return { ...room, status: current ? 'Occupied' : 'Available', current, next };
  });
}
function roomInput(b) {
  const room_no = String(b.room_no || '').trim(), name = String(b.name || '').trim();
  const floor = String(b.floor || '').trim();
  const capacity = Number(b.capacity || 0);
  const facilities = Array.isArray(b.facilities) ? b.facilities.map(f => String(f).trim()).filter(Boolean) : [];
  if (!room_no || !name) return { error: 'Room number and name are required' };
  if (room_no.length > 20 || name.length > 100 || floor.length > 40) return { error: 'Room number, name or floor is too long' };
  if (!Number.isInteger(capacity) || capacity < 0) return { error: 'Capacity must be a whole number' };
  return { value: { room_no, name, floor, capacity, facilities: JSON.stringify(facilities) } };
}

// ---------- health & settings
app.get('/api/health', (req, res) => res.json({ ok: true, service: 'RoomFlow API', database: 'SQLite' }));
// Diagnostic: shows the clock the server uses for booking status (should match your local time)
app.get('/api/time', (req, res) => res.json({
  server_local_time: nowStr(),
  server_utc_time: new Date().toISOString(),
  app_timezone: APP_TZ,
  host_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  TZ_env: process.env.TZ || null
}));

app.get('/api/settings', (req, res) => res.json(getSettings()));
app.put('/api/settings', (req, res) => {
  const body = req.body || {};
  const updates = {};
  for (const [k, v] of Object.entries(body)) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    const def = DEFAULT_SETTINGS[k];
    if (typeof def === 'number') {
      const n = Number(v);
      if (!Number.isInteger(n)) return bad(res, `${k} must be a whole number`);
      updates[k] = n;
    } else if (typeof def === 'boolean') {
      updates[k] = v === true || v === 'true';
    } else {
      updates[k] = String(v).trim().slice(0, 100);
    }
  }
  if (updates.time_format !== undefined && !['12', '24'].includes(updates.time_format)) return bad(res, 'time_format must be 12 or 24');
  if (updates.default_layout !== undefined && !LAYOUTS.includes(updates.default_layout)) return bad(res, 'Default layout must be landscape or portrait');
  if (updates.default_template !== undefined && !TEMPLATES.includes(updates.default_template)) return bad(res, 'Unknown default design');
  if (updates.default_duration !== undefined && (updates.default_duration < 5 || updates.default_duration > 720)) return bad(res, 'Default duration must be 5 to 720 minutes');
  if (updates.buffer_minutes !== undefined && (updates.buffer_minutes < 0 || updates.buffer_minutes > 120)) return bad(res, 'Buffer must be 0 to 120 minutes');
  if (updates.display_refresh_seconds !== undefined && (updates.display_refresh_seconds < 5 || updates.display_refresh_seconds > 3600)) return bad(res, 'Display refresh must be 5 to 3600 seconds');
  const up = db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  db.transaction(() => { for (const [k, v] of Object.entries(updates)) up.run(k, JSON.stringify(v)); })();
  const s = getSettings();
  io.emit('settings:changed', s);
  res.json(s);
});

// ---------- rooms
app.get('/api/rooms', (req, res) => res.json(db.prepare('SELECT * FROM rooms WHERE active=1 ORDER BY room_no').all().map(roomShape)));
app.get('/api/rooms/status', (req, res) => res.json(roomsWithStatus()));
app.post('/api/rooms', (req, res) => {
  const v = roomInput(req.body || {});
  if (v.error) return bad(res, v.error);
  try {
    const { room_no, name, floor, capacity, facilities } = v.value;
    const info = db.prepare('INSERT INTO rooms(room_no,name,floor,capacity,facilities) VALUES(?,?,?,?,?)').run(room_no, name, floor, capacity, facilities);
    const room = roomShape(db.prepare('SELECT * FROM rooms WHERE id=?').get(info.lastInsertRowid));
    io.emit('rooms:changed', room);
    res.status(201).json(room);
  } catch (e) {
    if (isUnique(e)) return bad(res, 'Room number already exists', 409);
    throw e;
  }
});
app.put('/api/rooms/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM rooms WHERE id=?').get(id)) return bad(res, 'Room not found', 404);
  const v = roomInput(req.body || {});
  if (v.error) return bad(res, v.error);
  try {
    const { room_no, name, floor, capacity, facilities } = v.value;
    db.prepare('UPDATE rooms SET room_no=?,name=?,floor=?,capacity=?,facilities=? WHERE id=?').run(room_no, name, floor, capacity, facilities, id);
    const room = roomShape(db.prepare('SELECT * FROM rooms WHERE id=?').get(id));
    io.emit('rooms:changed', room);
    res.json(room);
  } catch (e) {
    if (isUnique(e)) return bad(res, 'Room number already exists', 409);
    throw e;
  }
});
app.patch('/api/rooms/:id/active', (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM rooms WHERE id=?').get(id)) return bad(res, 'Room not found', 404);
  const active = req.body?.active === true || req.body?.active === 'true';
  if (!active) {
    const n = db.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE room_id=? AND status NOT IN ${FREE_STATUSES} AND end_at>?`).get(id, nowStr()).n;
    if (n) return bad(res, 'This room still has upcoming bookings. Cancel them first.', 409);
  }
  db.prepare('UPDATE rooms SET active=? WHERE id=?').run(active ? 1 : 0, id);
  io.emit('rooms:changed', { id });
  res.json(roomShape(db.prepare('SELECT * FROM rooms WHERE id=?').get(id)));
});

// ---------- bookings
app.get('/api/bookings', (req, res) => {
  const now = nowStr();
  const { from, to, room_id, status, q } = req.query;
  const where = [], args = [];
  if (isDate(from)) { where.push('b.start_at>=?'); args.push(from + ' 00:00:00'); }
  if (isDate(to)) { where.push('b.start_at<?'); args.push(addDays(to, 1) + ' 00:00:00'); }
  if (room_id) { where.push('b.room_id=?'); args.push(Number(room_id)); }
  if (status) { where.push('b.status=?'); args.push(String(status)); }
  if (q) {
    const like = `%${String(q)}%`;
    where.push('(b.title LIKE ? OR b.organizer LIKE ? OR r.name LIKE ? OR r.room_no LIKE ?)');
    args.push(like, like, like, like);
  }
  const sql = `${BOOKING_SQL}${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY b.start_at LIMIT 2000`;
  res.json(db.prepare(sql).all(...args).map(b => bookingShape(b, now)));
});
app.post('/api/bookings', (req, res) => {
  const v = validateBooking(req.body || {});
  if (v.error) return bad(res, v.error, v.conflict ? 409 : 400);
  const { room_id, title, organizer, start_at, end_at } = v.value;
  const status = bookingStatusFor(req.user.role, getSettings());
  const info = db.prepare('INSERT INTO bookings(room_id,title,organizer,start_at,end_at,status,created_by) VALUES(?,?,?,?,?,?,?)')
    .run(room_id, title, organizer, start_at, end_at, status, req.user.id);
  const booking = getBooking(info.lastInsertRowid);
  broadcastBooking('created', booking);
  if (booking.status === 'Pending') notifyTeamsApprovers(booking);
  res.status(201).json(booking);
});
app.put('/api/bookings/:id', (req, res) => {
  const id = Number(req.params.id);
  const old = db.prepare('SELECT * FROM bookings WHERE id=?').get(id);
  if (!old) return bad(res, 'Booking not found', 404);
  if (old.status === 'Cancelled') return bad(res, 'Cancelled bookings cannot be edited', 409);
  const v = validateBooking(req.body || {}, id);
  if (v.error) return bad(res, v.error, v.conflict ? 409 : 400);
  const { room_id, title, organizer, start_at, end_at } = v.value;
  // a rejected booking that the owner edits goes back through approval
  const newStatus = old.status === 'Rejected' ? bookingStatusFor(req.user.role, getSettings()) : old.status;
  db.prepare('UPDATE bookings SET room_id=?,title=?,organizer=?,start_at=?,end_at=?,status=?,reject_reason=NULL WHERE id=?')
    .run(room_id, title, organizer, start_at, end_at, newStatus, id);
  const booking = getBooking(id);
  broadcastBooking('updated', booking, old.room_id);
  res.json(booking);
});
app.patch('/api/bookings/:id/cancel', (req, res) => {
  const id = Number(req.params.id);
  const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(id);
  if (!b) return bad(res, 'Booking not found', 404);
  if (b.status === 'Cancelled') return bad(res, 'Booking is already cancelled', 409);
  if (b.status === 'Rejected') return bad(res, 'Rejected bookings do not need cancelling', 409);
  db.prepare("UPDATE bookings SET status='Cancelled' WHERE id=?").run(id);
  const booking = getBooking(id);
  broadcastBooking('cancelled', booking);
  res.json(booking);
});
app.patch('/api/bookings/:id/reject', (req, res) => {
  const id = Number(req.params.id);
  const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(id);
  if (!b) return bad(res, 'Booking not found', 404);
  if (b.status !== 'Pending') return bad(res, 'Only pending bookings can be rejected', 409);
  const reason = String(req.body?.reason || '').trim().slice(0, 200) || null;
  db.prepare("UPDATE bookings SET status='Rejected', reject_reason=? WHERE id=?").run(reason, id);
  const booking = getBooking(id);
  broadcastBooking('rejected', booking);
  res.json(booking);
});
app.patch('/api/bookings/:id/approve', (req, res) => {
  const id = Number(req.params.id);
  const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(id);
  if (!b) return bad(res, 'Booking not found', 404);
  if (b.status !== 'Pending') return bad(res, 'Only pending bookings can be approved', 409);
  db.prepare("UPDATE bookings SET status='Confirmed' WHERE id=?").run(id);
  const booking = getBooking(id);
  broadcastBooking('approved', booking);
  res.json(booking);
});

// ---------- display devices
const isOnline = d => !!d.last_seen && d.last_seen >= addMin(nowStr(), -ONLINE_WINDOW_MIN);
app.get('/api/devices', (req, res) => {
  const rows = db.prepare(`SELECT d.*, r.room_no, r.name AS room_name FROM devices d
    LEFT JOIN rooms r ON r.id=d.room_id AND r.active=1 WHERE d.active=1 ORDER BY d.id`).all();
  res.json(rows.map(d => ({ ...d, online: isOnline(d) })));
});
app.post('/api/devices/register', (req, res) => {
  const b = req.body || {};
  const device_code = String(b.device_code || '').trim().toUpperCase();
  const device_name = String(b.device_name || '').trim();
  const platform = String(b.platform || 'Android').trim().slice(0, 40);
  const room_id = b.room_id ? Number(b.room_id) : null;
  const opts = displayOptionsInput(b);
  if (opts.error) return bad(res, opts.error);
  if (!device_code || !device_name) return bad(res, 'Device code and device name are required');
  if (!/^[A-Z0-9_-]{2,40}$/.test(device_code)) return bad(res, 'Device code may only use letters, numbers, - and _');
  if (room_id && !db.prepare('SELECT id FROM rooms WHERE id=? AND active=1').get(room_id)) return bad(res, 'Room not found', 404);
  try {
    const info = db.prepare('INSERT INTO devices(device_code,device_name,platform,room_id,layout,template) VALUES(?,?,?,?,?,?)').run(device_code, device_name, platform, room_id, opts.value.layout, opts.value.template);
    const device = db.prepare('SELECT * FROM devices WHERE id=?').get(info.lastInsertRowid);
    io.emit('devices:changed', {});
    res.status(201).json(device);
  } catch (e) {
    if (isUnique(e)) return bad(res, 'Device code is already registered', 409);
    throw e;
  }
});
app.patch('/api/devices/:id/assign', (req, res) => {
  const id = Number(req.params.id);
  const room_id = req.body?.room_id ? Number(req.body.room_id) : null;
  const device = db.prepare('SELECT * FROM devices WHERE id=?').get(id);
  if (!device) return bad(res, 'Device not found', 404);
  if (room_id && !db.prepare('SELECT id FROM rooms WHERE id=? AND active=1').get(room_id)) return bad(res, 'Room not found', 404);
  db.prepare('UPDATE devices SET room_id=? WHERE id=?').run(room_id, id);
  const updated = db.prepare('SELECT * FROM devices WHERE id=?').get(id);
  io.to(`device:${updated.device_code}`).emit('display:refresh');
  io.emit('devices:changed', {});
  res.json(updated);
});
app.patch('/api/devices/:id/display', (req, res) => {
  const id = Number(req.params.id);
  const device = db.prepare('SELECT * FROM devices WHERE id=?').get(id);
  if (!device) return bad(res, 'Device not found', 404);
  const opts = displayOptionsInput(req.body || {});
  if (opts.error) return bad(res, opts.error);
  db.prepare('UPDATE devices SET layout=?, template=? WHERE id=?').run(opts.value.layout, opts.value.template, id);
  const updated = db.prepare('SELECT * FROM devices WHERE id=?').get(id);
  io.to(`device:${updated.device_code}`).emit('display:refresh');
  io.emit('devices:changed', {});
  res.json(updated);
});
app.delete('/api/devices/:id', (req, res) => {
  const device = db.prepare('SELECT * FROM devices WHERE id=?').get(Number(req.params.id));
  if (!device) return bad(res, 'Device not found', 404);
  db.prepare('DELETE FROM devices WHERE id=?').run(device.id);
  io.emit('devices:changed', { id: device.id, deleted: true });
  res.json({ ok: true });
});
app.get('/api/display/:deviceCode', (req, res) => {
  const device = db.prepare('SELECT * FROM devices WHERE device_code=? AND active=1').get(String(req.params.deviceCode).toUpperCase());
  if (!device) return bad(res, 'Device not registered', 404);
  const now = nowStr();
  db.prepare('UPDATE devices SET last_seen=? WHERE id=?').run(now, device.id);
  const s = getSettings();
  const settings = { system_name: s.system_name, time_format: s.time_format, display_refresh_seconds: s.display_refresh_seconds };
  const display = effectiveDisplay(device, s);
  const room = device.room_id ? db.prepare('SELECT * FROM rooms WHERE id=? AND active=1').get(device.room_id) : null;
  if (!room) return res.json({ device, room: null, current: null, upcoming: [], schedule: [], server_now: now, settings, display: effectiveDisplay(device, s) });
  // The tablet only shows confirmed meetings. Pending requests wait for approval and are not shown.
  const list = db.prepare(`${BOOKING_SQL} WHERE b.room_id=? AND b.status NOT IN ('Cancelled','Rejected','Pending') AND b.end_at>? ORDER BY b.start_at LIMIT 12`)
    .all(room.id, now).map(b => bookingShape(b, now));
  const current = list.find(b => b.time_state === 'Ongoing') || null;
  const upcoming = list.filter(b => b.time_state === 'Upcoming').slice(0, 1); // display shows only the next meeting
  // schedule: the next few live bookings, so the tablet can keep working offline from its saved copy
  const schedule = list.map(b => ({ id: b.id, title: b.title, organizer: b.organizer, start_at: b.start_at, end_at: b.end_at, status: b.status }));
  res.json({ device, room: roomShape(room), current, upcoming, schedule, server_now: now, settings, display });
});

// ---------- users (admin only, enforced by auth rules)
const USER_COLS = 'id,name,email,role,active';
const userOut = u => u && ({ ...u, active: !!u.active });
function userInput(b, requirePassword) {
  const name = String(b.name || '').trim(), email = String(b.email || '').trim().toLowerCase();
  const role = String(b.role || 'Staff');
  if (!db.prepare('SELECT 1 FROM roles WHERE name=?').get(role)) return { error: 'That role does not exist' };
  const password = String(b.password || '');
  if (!name || !email) return { error: 'Name and email are required' };
  if (name.length > 80) return { error: 'Name is too long' };
  if (!isEmail(email)) return { error: 'Email format is invalid' };
  if ((requirePassword || password) && password.length < 8) return { error: 'Password must be at least 8 characters' };
  return { value: { name, email, role, password: password || null } };
}
app.get('/api/users', (req, res) => res.json(db.prepare(`SELECT ${USER_COLS} FROM users ORDER BY name`).all().map(userOut)));
app.post('/api/users', (req, res) => {
  const v = userInput(req.body || {}, true);
  if (v.error) return bad(res, v.error);
  try {
    const info = db.prepare('INSERT INTO users(name,email,role,password_hash) VALUES(?,?,?,?)')
      .run(v.value.name, v.value.email, v.value.role, auth.hashPassword(v.value.password));
    const user = userOut(db.prepare(`SELECT ${USER_COLS} FROM users WHERE id=?`).get(info.lastInsertRowid));
    io.emit('users:changed', {});
    res.status(201).json(user);
  } catch (e) {
    if (isUnique(e)) return bad(res, 'Email already exists', 409);
    throw e;
  }
});
app.put('/api/users/:id', (req, res) => {
  const id = Number(req.params.id);
  const target = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!target) return bad(res, 'User not found', 404);
  const v = userInput(req.body || {}, false);
  if (v.error) return bad(res, v.error);
  const losesAdmin = target.role === 'Administrator' && target.active && v.value.role !== 'Administrator';
  if (losesAdmin && auth.countActiveAdmins() <= 1) return bad(res, 'At least one active Administrator is required', 409);
  try {
    db.transaction(() => {
      db.prepare('UPDATE users SET name=?,email=?,role=? WHERE id=?').run(v.value.name, v.value.email, v.value.role, id);
      if (v.value.password) db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(auth.hashPassword(v.value.password), id);
    })();
    io.emit('users:changed', {});
    res.json(userOut(db.prepare(`SELECT ${USER_COLS} FROM users WHERE id=?`).get(id)));
  } catch (e) {
    if (isUnique(e)) return bad(res, 'Email already exists', 409);
    throw e;
  }
});
app.patch('/api/users/:id/active', (req, res) => {
  const id = Number(req.params.id);
  const target = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!target) return bad(res, 'User not found', 404);
  const active = req.body?.active === true || req.body?.active === 'true';
  if (!active) {
    if (id === req.user.id) return bad(res, 'You cannot disable your own account', 409);
    if (target.role === 'Administrator' && auth.countActiveAdmins() <= 1) return bad(res, 'At least one active Administrator is required', 409);
  }
  db.prepare('UPDATE users SET active=? WHERE id=?').run(active ? 1 : 0, id);
  io.emit('users:changed', {});
  res.json(userOut(db.prepare(`SELECT ${USER_COLS} FROM users WHERE id=?`).get(id)));
});

// ---------- roles (admins create roles and tick the permissions each one gets)
const roleOut = r => ({
  name: r.name, system: !!r.system, perms: JSON.parse(r.perms),
  user_count: db.prepare('SELECT COUNT(*) AS n FROM users WHERE role=?').get(r.name).n
});
function roleInput(b) {
  const name = String(b.name || '').trim();
  const perms = Array.isArray(b.perms) ? [...new Set(b.perms.map(String))] : [];
  if (name.length < 2 || name.length > 40) return { error: 'Role name must be 2 to 40 characters' };
  const unknown = perms.filter(k => !auth.ALL_PERMS.includes(k));
  if (unknown.length) return { error: `Unknown permission: ${unknown[0]}` };
  return { value: { name, perms: perms.filter(k => auth.ALL_PERMS.includes(k)) } };
}
app.get('/api/roles', (req, res) => res.json({
  roles: db.prepare('SELECT * FROM roles ORDER BY system DESC, name').all().map(roleOut),
  catalog: auth.PERM_CATALOG
}));
app.post('/api/roles', (req, res) => {
  const v = roleInput(req.body || {});
  if (v.error) return bad(res, v.error);
  if (db.prepare('SELECT 1 FROM roles WHERE name=? COLLATE NOCASE').get(v.value.name)) return bad(res, 'A role with that name already exists', 409);
  db.prepare('INSERT INTO roles(name,perms,system) VALUES(?,?,0)').run(v.value.name, JSON.stringify(v.value.perms));
  io.emit('roles:changed', {});
  res.status(201).json(roleOut(db.prepare('SELECT * FROM roles WHERE name=?').get(v.value.name)));
});
app.put('/api/roles/:name', (req, res) => {
  const oldName = req.params.name;
  const role = db.prepare('SELECT * FROM roles WHERE name=?').get(oldName);
  if (!role) return bad(res, 'Role not found', 404);
  if (role.system) return bad(res, 'The Administrator role is built in and cannot be changed', 409);
  const v = roleInput(req.body || {});
  if (v.error) return bad(res, v.error);
  if (v.value.name.toLowerCase() !== oldName.toLowerCase() && db.prepare('SELECT 1 FROM roles WHERE name=? COLLATE NOCASE').get(v.value.name))
    return bad(res, 'A role with that name already exists', 409);
  db.transaction(() => {
    db.prepare('UPDATE roles SET name=?, perms=? WHERE name=?').run(v.value.name, JSON.stringify(v.value.perms), oldName);
    if (v.value.name !== oldName) db.prepare('UPDATE users SET role=? WHERE role=?').run(v.value.name, oldName);
  })();
  io.emit('roles:changed', {});
  io.emit('users:changed', {});
  res.json(roleOut(db.prepare('SELECT * FROM roles WHERE name=?').get(v.value.name)));
});
app.delete('/api/roles/:name', (req, res) => {
  const role = db.prepare('SELECT * FROM roles WHERE name=?').get(req.params.name);
  if (!role) return bad(res, 'Role not found', 404);
  if (role.system) return bad(res, 'The Administrator role is built in and cannot be deleted', 409);
  const n = db.prepare('SELECT COUNT(*) AS n FROM users WHERE role=?').get(role.name).n;
  if (n) return bad(res, `${n} user(s) still have this role. Change their role first.`, 409);
  db.prepare('DELETE FROM roles WHERE name=?').run(role.name);
  io.emit('roles:changed', {});
  res.json({ ok: true });
});

// ---------- authentication
app.get('/api/auth/status', (req, res) => res.json({ needs_setup: !auth.hasAnyPassword() }));
app.post('/api/auth/setup', (req, res) => {
  if (auth.hasAnyPassword()) return bad(res, 'Setup is already complete', 409);
  const b = req.body || {};
  const name = String(b.name || '').trim(), email = String(b.email || '').trim().toLowerCase();
  const password = String(b.password || '');
  if (!name || !isEmail(email)) return bad(res, 'Name and a valid email are required');
  if (password.length < 8) return bad(res, 'Password must be at least 8 characters');
  const hash = auth.hashPassword(password);
  const existing = db.prepare('SELECT id FROM users WHERE email=?').get(email);
  let id;
  if (existing) {
    db.prepare("UPDATE users SET name=?,role='Administrator',active=1,password_hash=? WHERE id=?").run(name, hash, existing.id);
    id = existing.id;
  } else {
    id = db.prepare("INSERT INTO users(name,email,role,password_hash) VALUES(?,?,'Administrator',?)").run(name, email, hash).lastInsertRowid;
  }
  const user = auth.publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(id));
  auth.login(req, res, user);
  res.status(201).json(auth.withPerms(user));
});
app.post('/api/auth/login', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!u || !u.active || !auth.verifyPassword(password, u.password_hash)) return bad(res, 'Email or password is incorrect', 401);
  const user = auth.publicUser(u);
  auth.login(req, res, user);
  res.json(auth.withPerms(user));
});
app.post('/api/auth/logout', (req, res) => { auth.logout(req, res); res.json({ ok: true }); });
app.get('/api/auth/me', (req, res) => {
  const u = auth.currentUser(req);
  if (!u) return bad(res, 'Not logged in', 401);
  res.json(auth.withPerms(u));
});
app.post('/api/auth/password', (req, res) => {
  const u = auth.currentUser(req);
  if (!u) return bad(res, 'Not logged in', 401);
  const row = db.prepare('SELECT password_hash FROM users WHERE id=?').get(u.id);
  if (!auth.verifyPassword(String(req.body?.current || ''), row.password_hash)) return bad(res, 'Current password is incorrect', 400);
  const next = String(req.body?.new || '');
  if (next.length < 8) return bad(res, 'New password must be at least 8 characters');
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(auth.hashPassword(next), u.id);
  res.json({ ok: true });
});

// ---------- floor plan
const CANVAS_W = 1000, CANVAS_H = 600;
const levelNames = () => {
  const named = db.prepare('SELECT name FROM floor_levels ORDER BY sort, name').all().map(r => r.name);
  const fromRooms = db.prepare("SELECT DISTINCT floor FROM rooms WHERE floor IS NOT NULL AND floor!=''").all().map(r => r.floor);
  return [...new Set([...named, ...fromRooms])];
};
app.get('/api/floorplan', (req, res) => {
  const rooms = roomsWithStatus().map(r => ({
    id: r.id, room_no: r.room_no, name: r.name, floor: r.floor || '', capacity: r.capacity,
    facilities: r.facilities, status: r.status, current: r.current, next: r.next,
    x: r.map_x, y: r.map_y, w: r.map_w, h: r.map_h
  }));
  res.json({ levels: levelNames(), canvas: { w: CANVAS_W, h: CANVAS_H }, rooms });
});
app.put('/api/floorplan/rooms', (req, res) => {
  const list = req.body?.rooms;
  if (!Array.isArray(list)) return bad(res, 'rooms must be a list');
  const inRange = (v, min, max) => {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : NaN;
  };
  const updates = [];
  for (const r of list) {
    const id = Number(r.id);
    if (!db.prepare('SELECT 1 FROM rooms WHERE id=?').get(id)) continue;
    const x = inRange(r.x, 0, CANVAS_W - 40), y = inRange(r.y, 0, CANVAS_H - 40);
    const w = inRange(r.w, 40, CANVAS_W), h = inRange(r.h, 40, CANVAS_H);
    if ([x, y, w, h].some(Number.isNaN)) return bad(res, `Room ${id}: position or size is out of range`);
    const placed = x !== null && y !== null && w !== null && h !== null;
    const floor = String(r.floor || '').trim().slice(0, 40);
    updates.push([floor, placed ? x : null, placed ? y : null, placed ? w : null, placed ? h : null, id]);
  }
  db.transaction(() => {
    const up = db.prepare('UPDATE rooms SET floor=?, map_x=?, map_y=?, map_w=?, map_h=? WHERE id=?');
    for (const u of updates) up.run(...u);
  })();
  io.emit('rooms:changed', {});
  res.json({ ok: true, saved: updates.length });
});
app.post('/api/floorplan/levels', (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 40);
  if (!name) return bad(res, 'Level name is required');
  if (levelNames().includes(name)) return bad(res, 'A level with that name already exists', 409);
  db.prepare('INSERT INTO floor_levels(name,sort) VALUES(?,(SELECT COALESCE(MAX(sort),0)+1 FROM floor_levels))').run(name);
  io.emit('rooms:changed', {});
  res.status(201).json({ name });
});
app.patch('/api/floorplan/levels/:name', (req, res) => {
  const from = req.params.name;
  const to = String(req.body?.name || '').trim().slice(0, 40);
  if (!to) return bad(res, 'Level name is required');
  if (!levelNames().includes(from)) return bad(res, 'Level not found', 404);
  if (to !== from && levelNames().includes(to)) return bad(res, 'A level with that name already exists', 409);
  db.transaction(() => {
    db.prepare('UPDATE rooms SET floor=? WHERE floor=?').run(to, from);
    db.prepare('DELETE FROM floor_levels WHERE name=?').run(from);
    db.prepare('INSERT OR IGNORE INTO floor_levels(name,sort) VALUES(?,(SELECT COALESCE(MAX(sort),0)+1 FROM floor_levels))').run(to);
  })();
  io.emit('rooms:changed', {});
  res.json({ name: to });
});
app.delete('/api/floorplan/levels/:name', (req, res) => {
  const name = req.params.name;
  if (!levelNames().includes(name)) return bad(res, 'Level not found', 404);
  const n = db.prepare("SELECT COUNT(*) AS n FROM rooms WHERE floor=? AND active=1").get(name).n;
  if (n) return bad(res, `${n} room(s) are on this level. Move them to another level first.`, 409);
  db.prepare('DELETE FROM floor_levels WHERE name=?').run(name);
  io.emit('rooms:changed', {});
  res.json({ ok: true });
});

// ---------- personal calendar (read-only link to your Outlook / Google / Apple calendar)
db.exec(`CREATE TABLE IF NOT EXISTS user_calendars (
  user_id INTEGER PRIMARY KEY, url TEXT NOT NULL, last_sync INTEGER, last_error TEXT
);`);
db.exec(`CREATE TABLE IF NOT EXISTS user_calendar_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, uid TEXT, title TEXT,
  location TEXT, start_at TEXT NOT NULL, end_at TEXT NOT NULL
);`);
db.exec('CREATE INDEX IF NOT EXISTS idx_user_cal ON user_calendar_events(user_id, start_at)');
const CAL_SYNC_MINUTES = 15;

// Only public web addresses. Blocks this server's own network (SSRF).
function checkCalendarUrl(raw) {
  let u = String(raw || '').trim();
  if (/^webcal:\/\//i.test(u)) u = 'https://' + u.slice(9);
  let parsed;
  try { parsed = new URL(u); } catch (_) { return { error: 'That is not a valid link' }; }
  if (parsed.protocol !== 'https:') return { error: 'The link must start with https:// or webcal://' };
  const h = parsed.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || /^(127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0|::1|172\.(1[6-9]|2\d|3[01])\.)/.test(h))
    return { error: 'That address is not allowed' };
  return { value: parsed.toString() };
}
function applyCalendarEvents(userId, events) {
  const now = Date.now(), from = addDays(nowStr().slice(0, 10), -60), to = addDays(nowStr().slice(0, 10), 365);
  db.transaction(() => {
    db.prepare('DELETE FROM user_calendar_events WHERE user_id=?').run(userId);
    const ins = db.prepare('INSERT INTO user_calendar_events(user_id,uid,title,location,start_at,end_at) VALUES(?,?,?,?,?,?)');
    for (const e of events) if (e.start_at.slice(0, 10) >= from && e.start_at.slice(0, 10) <= to) ins.run(userId, e.uid, e.title, e.location, e.start_at, e.end_at);
  })();
  db.prepare('UPDATE user_calendars SET last_sync=?, last_error=NULL WHERE user_id=?').run(now, userId);
}
async function syncUserCalendar(userId) {
  const row = db.prepare('SELECT * FROM user_calendars WHERE user_id=?').get(userId);
  if (!row) return null;
  try {
    const res = await fetch(row.url, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'RoomFlow' } });
    if (!res.ok) throw new Error(`The calendar link answered with ${res.status}`);
    const text = await res.text();
    if (text.length > 3000000) throw new Error('The calendar file is too large');
    if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('This link does not return a calendar (.ics) file');
    applyCalendarEvents(userId, parseIcs(text, APP_TZ));
  } catch (e) {
    db.prepare('UPDATE user_calendars SET last_sync=?, last_error=? WHERE user_id=?').run(Date.now(), String(e.message).slice(0, 200), userId);
  }
  return db.prepare('SELECT url, last_sync, last_error FROM user_calendars WHERE user_id=?').get(userId);
}
const calStatus = userId => {
  const row = db.prepare('SELECT url, last_sync, last_error FROM user_calendars WHERE user_id=?').get(userId);
  return row ? { connected: true, url: row.url, last_sync: row.last_sync, last_error: row.last_error }
    : { connected: false };
};
app.get('/api/me/calendar', (req, res) => res.json(calStatus(req.user.id)));
app.put('/api/me/calendar', async (req, res) => {
  const v = checkCalendarUrl(req.body?.url);
  if (v.error) return bad(res, v.error);
  db.prepare('INSERT INTO user_calendars(user_id,url,last_sync,last_error) VALUES(?,?,NULL,NULL) ON CONFLICT(user_id) DO UPDATE SET url=excluded.url, last_sync=NULL, last_error=NULL')
    .run(req.user.id, v.value);
  await syncUserCalendar(req.user.id);
  res.json(calStatus(req.user.id));
});
app.post('/api/me/calendar/sync', async (req, res) => {
  if (!db.prepare('SELECT 1 FROM user_calendars WHERE user_id=?').get(req.user.id)) return bad(res, 'Connect a calendar first', 404);
  await syncUserCalendar(req.user.id);
  res.json(calStatus(req.user.id));
});
app.delete('/api/me/calendar', (req, res) => {
  db.transaction(() => {
    db.prepare('DELETE FROM user_calendar_events WHERE user_id=?').run(req.user.id);
    db.prepare('DELETE FROM user_calendars WHERE user_id=?').run(req.user.id);
  })();
  res.json({ ok: true });
});
app.get('/api/me/calendar/events', async (req, res) => {
  const row = db.prepare('SELECT last_sync FROM user_calendars WHERE user_id=?').get(req.user.id);
  if (!row) return res.json({ connected: false, events: [] });
  // refresh automatically when the copy is older than 15 minutes
  if (!row.last_sync || Date.now() - row.last_sync > CAL_SYNC_MINUTES * 60000) await syncUserCalendar(req.user.id);
  const { from, to } = req.query;
  const where = ['user_id=?'], args = [req.user.id];
  if (isDate(from)) { where.push('start_at>=?'); args.push(from + ' 00:00:00'); }
  if (isDate(to)) { where.push('start_at<?'); args.push(addDays(to, 1) + ' 00:00:00'); }
  const events = db.prepare(`SELECT id,title,location,start_at,end_at FROM user_calendar_events WHERE ${where.join(' AND ')} ORDER BY start_at LIMIT 2000`).all(...args);
  res.json({ connected: true, status: calStatus(req.user.id), events });
});

// ---------- Microsoft Teams integration
// Admin: read / change the toggle, webhook, and generate the API key (shown once)
app.get('/api/integrations/teams', (req, res) => res.json({
  enabled: teamsOn(),
  webhook_url: intGet('teams_webhook_url') || '',
  key_set: !!intGet('teams_key_hash'),
  endpoint: '/api/integrations/teams/booking'
}));
app.put('/api/integrations/teams', (req, res) => {
  const b = req.body || {};
  if (b.enabled !== undefined) intSet('teams_enabled', b.enabled === true || b.enabled === 'true' ? '1' : '0');
  if (b.webhook_url !== undefined) {
    const url = String(b.webhook_url || '').trim();
    if (url && !/^https:\/\//i.test(url)) return bad(res, 'Webhook address must start with https://');
    intSet('teams_webhook_url', url);
  }
  res.json({ ok: true });
});
app.post('/api/integrations/teams/key', (req, res) => {
  const key = crypto.randomBytes(24).toString('hex');
  intSet('teams_key_hash', sha256(key));
  res.status(201).json({ key, note: 'Copy this key now. It will not be shown again.' });
});

// Teams side: create a booking with only the mandatory details
// Required: room (room number), title, organizer (name or email), start, end
app.post('/api/integrations/teams/booking', async (req, res) => {
  if (!teamsOn()) return bad(res, 'Microsoft Teams integration is turned off in Settings', 403);
  const key = String(req.headers['x-roomflow-key'] || '');
  const stored = intGet('teams_key_hash');
  if (!stored || !key || sha256(key) !== stored) return bad(res, 'Invalid or missing API key', 401);

  const b = req.body || {};
  const room = String(b.room ?? '').trim();
  const title = String(b.title ?? '').trim();
  const organizer = String(b.organizer ?? '').trim();
  const start = toVenueTime(b.start), end = toVenueTime(b.end);
  const missing = [!room && 'room', !title && 'title', !organizer && 'organizer', !start && 'start', !end && 'end'].filter(Boolean);
  if (missing.length) return bad(res, `Missing required field(s): ${missing.join(', ')}`);

  const roomRow = db.prepare('SELECT id FROM rooms WHERE room_no=? AND active=1').get(room);
  if (!roomRow) return bad(res, `Room "${room}" not found`, 404);

  // Match the organizer to a RoomFlow user (by email, else by name) so their role decides approval
  const who = db.prepare('SELECT id, name, role FROM users WHERE active=1 AND (email=? OR name=?)')
    .get(organizer.toLowerCase(), organizer) || null;

  const v = validateBooking({ room_id: roomRow.id, title, organizer, start_at: start, end_at: end });
  if (v.error) return bad(res, v.error, v.conflict ? 409 : 400);
  const s = getSettings();
  const status = bookingStatusFor(who ? who.role : '', s);
  const info = db.prepare('INSERT INTO bookings(room_id,title,organizer,start_at,end_at,status,created_by) VALUES(?,?,?,?,?,?,?)')
    .run(v.value.room_id, title, who ? who.name : organizer, v.value.start_at, v.value.end_at, status, who ? who.id : null);
  const booking = getBooking(info.lastInsertRowid);
  broadcastBooking('created', booking);
  if (status === 'Pending') notifyTeamsApprovers(booking);
  res.status(201).json({
    id: booking.id, status: booking.status, room: booking.room_no, title: booking.title,
    start: booking.start_at, end: booking.end_at,
    message: status === 'Pending' ? 'Booking sent for approval' : 'Booking confirmed'
  });
});

// Accept "2026-11-20T10:00", "2026-11-20 10:00" or ISO with an offset (e.g. +08:00 or Z) and convert to venue time
function toVenueTime(v) {
  if (typeof v !== 'string') return null;
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(v.trim())) {
    const d = new Date(v.trim());
    if (isNaN(d)) return null;
    return new Intl.DateTimeFormat('sv-SE', { timeZone: APP_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(d).replace('T', ' ');
  }
  return normDateTime(v);
}

// Posts a card to the Teams channel (Power Automate Workflows webhook) so approvers see new requests
async function notifyTeamsApprovers(booking) {
  const url = intGet('teams_webhook_url');
  if (!teamsOn() || !url) return;
  const card = {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        type: 'AdaptiveCard', version: '1.4',
        body: [
          { type: 'TextBlock', weight: 'Bolder', size: 'Medium', text: 'Room booking waiting for approval' },
          { type: 'FactSet', facts: [
            { title: 'Room', value: `${booking.room_no} · ${booking.room_name}` },
            { title: 'Meeting', value: booking.title },
            { title: 'Organizer', value: booking.organizer },
            { title: 'When', value: `${booking.start_at.slice(0, 10)} ${booking.start_at.slice(11, 16)} – ${booking.end_at.slice(11, 16)}` }
          ] },
          { type: 'TextBlock', wrap: true, text: 'Approve or reject it in RoomFlow › Bookings.' }
        ]
      }
    }]
  };
  try {
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(card), signal: AbortSignal.timeout(8000) });
  } catch (e) {
    console.error('Teams notification failed:', e.message);
  }
}

// ---------- unknown api + errors
app.use('/api', (req, res) => bad(res, 'Not found', 404));
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return bad(res, 'Invalid JSON body');
  console.error(err);
  bad(res, 'Server error', 500);
});

// ---------- realtime
io.on('connection', socket => {
  socket.on('display:join', ({ deviceCode } = {}) => {
    const device = db.prepare('SELECT * FROM devices WHERE device_code=? AND active=1').get(String(deviceCode || '').toUpperCase());
    if (!device) return socket.emit('display:error', { error: 'Unknown device' });
    db.prepare('UPDATE devices SET last_seen=? WHERE id=?').run(nowStr(), device.id);
    for (const r of socket.rooms) if (r.startsWith('room:')) socket.leave(r);
    socket.join(`device:${device.device_code}`);
    if (device.room_id) socket.join(`room:${device.room_id}`);
    socket.emit('display:ready', { device, room_id: device.room_id });
  });
});

server.listen(PORT, () => console.log(`RoomFlow running: http://localhost:${PORT}`));
