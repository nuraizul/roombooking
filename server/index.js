const express = require('express');
const crypto = require('crypto');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
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
// Custom display designs
db.exec(`CREATE TABLE IF NOT EXISTS display_designs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, orientation TEXT NOT NULL,
  bg TEXT NOT NULL, elements TEXT NOT NULL DEFAULT '[]', updated_at TEXT)`);
// Email booking: every email handled, for the Activity list in Settings
db.exec(`CREATE TABLE IF NOT EXISTS inbound_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, received_at TEXT NOT NULL, sender TEXT,
  subject TEXT, outcome TEXT NOT NULL, message TEXT, booking_id INTEGER)`);
// Statuses that do not hold the room
const FREE_STATUSES = "('Cancelled','Rejected')";
const displayOptionsInput = b => {
  const layout = b.layout === undefined || b.layout === '' || b.layout === null ? null : String(b.layout);
  const template = b.template === undefined || b.template === '' || b.template === null ? null : String(b.template);
  if (layout && !LAYOUTS.includes(layout)) return { error: 'Layout must be landscape or portrait' };
  if (template && !validTemplate(template)) return { error: 'Unknown design' };
  return { value: { layout, template } };
};
// Which design a tablet shows: a custom design when chosen, otherwise a built-in template
function designFor(device, s) {
  const template = device.template || s.default_template;
  const row = /^design:\d+$/.test(template) ? db.prepare('SELECT * FROM display_designs WHERE id=?').get(Number(template.slice(7))) : null;
  if (!row) return { display: effectiveDisplay(device, s), design: null };
  const design = { id: row.id, name: row.name, orientation: row.orientation, bg: row.bg, elements: JSON.parse(row.elements) };
  return { display: { layout: row.orientation, template }, design };
}
const effectiveDisplay = (device, s) => ({
  layout: device.layout || s.default_layout,
  template: device.template || s.default_template
});

const PORT = process.env.PORT || 3000;
const ONLINE_WINDOW_MIN = 2;
const ROLES = ['Administrator', 'Staff'];
const LAYOUTS = ['landscape', 'portrait'];
const TEMPLATES = ['classic', 'minimal', 'bold'];
const ELEMENT_TYPES = ['text', 'image', 'video', 'clock', 'room_name', 'status', 'current', 'next', 'schedule', 'facilities', 'shape'];
// A template is a built-in name, or "design:<id>" for a custom design
const validTemplate = t => TEMPLATES.includes(t) || (/^design:\d+$/.test(String(t)) && !!db.prepare('SELECT 1 FROM display_designs WHERE id=?').get(Number(String(t).slice(7))));
const DEFAULT_SETTINGS = {
  inbound_enabled: false,
  inbound_secret: '',
  inbound_open: '08:00',
  inbound_close: '18:00',
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
  if (c) return { error: `Room is already booked ${c.start_at.slice(11, 16)}–${c.end_at.slice(11, 16)} (${c.title})`, conflict: true, clash: c };
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

app.get('/api/settings', (req, res) => {
  const s = getSettings();
  if (!auth.can(req.user, 'settings.manage')) delete s.inbound_secret;
  res.json(s);
});
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
  for (const k of ['inbound_open', 'inbound_close']) {
    if (updates[k] !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(updates[k])) return bad(res, `${k} must be a time like 08:00`);
  }
  if (updates.inbound_enabled === true && !(updates.inbound_secret || getSettings().inbound_secret)) {
    updates.inbound_secret = crypto.randomBytes(24).toString('hex');
  }
  if (updates.default_template !== undefined && !validTemplate(updates.default_template)) return bad(res, 'Unknown default design');
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
  const design = designFor(device, s);
  if (!room) return res.json({ device, room: null, current: null, upcoming: [], schedule: [], server_now: now, settings, display: design.display, design: design.design });
  // The tablet only shows confirmed meetings. Pending requests wait for approval and are not shown.
  const list = db.prepare(`${BOOKING_SQL} WHERE b.room_id=? AND b.status NOT IN ('Cancelled','Rejected','Pending') AND b.end_at>? ORDER BY b.start_at LIMIT 12`)
    .all(room.id, now).map(b => bookingShape(b, now));
  const current = list.find(b => b.time_state === 'Ongoing') || null;
  const upcoming = list.filter(b => b.time_state === 'Upcoming').slice(0, 1); // display shows only the next meeting
  // schedule: the next few live bookings, so the tablet can keep working offline from its saved copy
  const schedule = list.map(b => ({ id: b.id, title: b.title, organizer: b.organizer, start_at: b.start_at, end_at: b.end_at, status: b.status }));
  res.json({ device, room: roomShape(room), current, upcoming, schedule, server_now: now, settings, display: design.display, design: design.design });
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

// ---------- custom display designs
const designRow = r => ({ id: r.id, name: r.name, orientation: r.orientation, bg: r.bg, updated_at: r.updated_at, elements: JSON.parse(r.elements || '[]') });
const cleanText = (v, max = 2000) => String(v ?? '').slice(0, max);
const safeUrl = (v, allowData) => {
  const t = String(v || '').trim();
  if (/^https?:\/\//i.test(t)) return t.slice(0, 2000);
  if (allowData && /^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,/i.test(t)) return t;
  return '';
};
function sanitizeProps(p) {
  const out = {};
  for (const [k, v] of Object.entries(p).slice(0, 40)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = /url|src/i.test(k) ? safeUrl(v, k === 'imageUrl' || k === 'url') : cleanText(v);
  }
  return out;
}
function designInput(b) {
  const name = String(b.name || '').trim();
  if (name.length < 2 || name.length > 60) return { error: 'Design name must be 2 to 60 characters' };
  const orientation = LAYOUTS.includes(b.orientation) ? b.orientation : 'landscape';
  const bg = /^#[0-9a-fA-F]{6}$/.test(b.bg || '') ? b.bg : '#0e1522';
  if (!Array.isArray(b.elements) || b.elements.length > 80) return { error: 'elements must be a list of up to 80 items' };
  const num = (v, min, max, def) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };
  const elements = [];
  for (const e of b.elements) {
    if (!ELEMENT_TYPES.includes(e.type)) return { error: `Unknown element: ${e.type}` };
    elements.push({
      id: cleanText(e.id, 40) || Math.random().toString(36).slice(2, 10), type: e.type,
      x: num(e.x, 0, 100, 0), y: num(e.y, 0, 100, 0), w: num(e.w, 1, 100, 20), h: num(e.h, 1, 100, 10),
      show: ['always', 'free', 'busy'].includes(e.show) ? e.show : 'always',
      props: e.props && typeof e.props === 'object' ? sanitizeProps(e.props) : {}
    });
  }
  const json = JSON.stringify(elements);
  if (json.length > 3000000) return { error: 'Design is too large. Use smaller images.' };
  return { value: { name, orientation, bg, elements: json } };
}
app.get('/api/designs', (req, res) => res.json(db.prepare('SELECT id,name,orientation,updated_at FROM display_designs ORDER BY name').all()));
app.get('/api/designs/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM display_designs WHERE id=?').get(Number(req.params.id));
  if (!row) return bad(res, 'Design not found', 404);
  res.json(designRow(row));
});
app.post('/api/designs', (req, res) => {
  const v = designInput(req.body || {});
  if (v.error) return bad(res, v.error);
  try {
    const info = db.prepare('INSERT INTO display_designs(name,orientation,bg,elements,updated_at) VALUES(?,?,?,?,?)')
      .run(v.value.name, v.value.orientation, v.value.bg, v.value.elements, nowStr());
    res.status(201).json(designRow(db.prepare('SELECT * FROM display_designs WHERE id=?').get(info.lastInsertRowid)));
  } catch (e) {
    if (isUnique(e)) return bad(res, 'A design with that name already exists', 409);
    throw e;
  }
});
app.put('/api/designs/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM display_designs WHERE id=?').get(id)) return bad(res, 'Design not found', 404);
  const v = designInput(req.body || {});
  if (v.error) return bad(res, v.error);
  try {
    db.prepare('UPDATE display_designs SET name=?,orientation=?,bg=?,elements=?,updated_at=? WHERE id=?')
      .run(v.value.name, v.value.orientation, v.value.bg, v.value.elements, nowStr(), id);
    io.emit('devices:changed', {});
    res.json(designRow(db.prepare('SELECT * FROM display_designs WHERE id=?').get(id)));
  } catch (e) {
    if (isUnique(e)) return bad(res, 'A design with that name already exists', 409);
    throw e;
  }
});
app.delete('/api/designs/:id', (req, res) => {
  const id = Number(req.params.id);
  const tpl = `design:${id}`;
  if (!db.prepare('SELECT 1 FROM display_designs WHERE id=?').get(id)) return bad(res, 'Design not found', 404);
  const n = db.prepare('SELECT COUNT(*) AS n FROM devices WHERE template=?').get(tpl).n;
  if (n || getSettings().default_template === tpl) return bad(res, 'This design is used by a display. Switch those displays to another design first.', 409);
  db.prepare('DELETE FROM display_designs WHERE id=?').run(id);
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

// ---------- email booking (Power Automate reads the mailbox and calls this)
const SUBJECT_RE = /^\s*\[(BOOK|CANCEL)\]\s*([^|]+?)\s*\|\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*\|\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*(?:\|\s*(.+?))?\s*$/i;
const FORMAT_HELP = 'Format subject: [BOOK] Bilik 101 | 25/11/2026 | 14:00-15:00 | Tajuk mesyuarat';
function parseInboundSubject(subject) {
  const m = String(subject || '').match(SUBJECT_RE);
  if (!m) return { error: 'Subject tidak sah. ' + FORMAT_HELP };
  const [, action, roomText, dd, mm, yyyy, t1, t2, title] = m;
  const date = `${yyyy}-${pad(Number(mm))}-${pad(Number(dd))}`;
  const probe = new Date(date + 'T00:00:00');
  if (isNaN(probe) || probe.getDate() !== Number(dd)) return { error: 'Tarikh tidak sah. ' + FORMAT_HELP };
  const hm = t => { const [h, mi] = t.split(':').map(Number); return h < 24 && mi < 60 ? `${pad(h)}:${pad(mi)}` : null; };
  const st = hm(t1), en = hm(t2);
  if (!st || !en) return { error: 'Masa tidak sah. ' + FORMAT_HELP };
  return { value: {
    action: action.toUpperCase(), roomText: roomText.replace(/^(bilik|room)\s*/i, '').trim(), date,
    start_at: `${date} ${st}:00`, end_at: `${date} ${en}:00`, title: (title || '').trim()
  } };
}
function freeSlots(room, date, minutes, max = 5) {
  const s = getSettings();
  const toMin = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const open = toMin(s.inbound_open), close = toMin(s.inbound_close), now = nowStr();
  const out = [];
  for (let t = open; t + minutes <= close && out.length < max; t += 30) {
    const st = `${date} ${pad(Math.floor(t / 60))}:${pad(t % 60)}:00`;
    const en = addMin(st, minutes);
    if (st < now) continue;
    if (!findConflict(room.id, st, en, null, s.buffer_minutes)) out.push(`${st.slice(11, 16)}-${en.slice(11, 16)}`);
  }
  return out;
}
function secretOk(given, expected) {
  const a = Buffer.from(String(given || '')), b = Buffer.from(String(expected || ''));
  return b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}
app.post('/api/inbound/email', (req, res) => {
  const s = getSettings();
  const received = nowStr();
  const sender = String(req.body?.from || '').trim().toLowerCase();
  const subject = String(req.body?.subject || '').trim();
  const log = (outcome, message, bookingId = null) => db.prepare(
    'INSERT INTO inbound_log(received_at,sender,subject,outcome,message,booking_id) VALUES(?,?,?,?,?,?)'
  ).run(received, sender || null, subject.slice(0, 200), outcome, message, bookingId);
  const reply = (code, body) => res.status(code).json({ ok: code < 300, ...body });

  if (!s.inbound_enabled) return reply(403, { message: 'Tempahan melalui email sedang dimatikan.' });
  if (!secretOk(req.get('X-Inbound-Secret'), s.inbound_secret)) {
    log('rejected', 'Secret tidak sah');
    return reply(401, { message: 'Secret tidak sah.' });
  }
  if (!sender) { log('invalid', 'Pengirim tiada'); return reply(400, { message: 'Alamat pengirim diperlukan.' }); }
  const p = parseInboundSubject(subject);
  if (p.error) { log('invalid', p.error); return reply(400, { message: p.error }); }
  const v = p.value;
  const room = db.prepare('SELECT * FROM rooms WHERE active=1 AND (LOWER(room_no)=LOWER(?) OR LOWER(name)=LOWER(?))').get(v.roomText, v.roomText);
  if (!room) {
    const names = db.prepare('SELECT room_no FROM rooms WHERE active=1 ORDER BY room_no').all().map(r => r.room_no).join(', ');
    const message = `Bilik "${v.roomText}" tidak dijumpai. Nombor bilik yang sah: ${names}.`;
    log('invalid', message);
    return reply(400, { message });
  }
  const user = db.prepare('SELECT id,name,role FROM users WHERE LOWER(email)=? AND active=1').get(sender);
  const when = `${v.date} ${v.start_at.slice(11, 16)}-${v.end_at.slice(11, 16)}`;

  if (v.action === 'CANCEL') {
    const b = db.prepare(`SELECT * FROM bookings WHERE room_id=? AND start_at=? AND end_at=? AND status NOT IN ('Cancelled','Rejected') ORDER BY id DESC LIMIT 1`)
      .get(room.id, v.start_at, v.end_at);
    if (!b) { const message = `Tiada tempahan aktif untuk ${room.name} pada ${when}.`; log('not_found', message); return reply(404, { message }); }
    const mine = (user && b.created_by === user.id) || b.organizer.toLowerCase() === sender || (user && auth.can(user, 'bookings.manage'));
    if (!mine) { const message = 'Tempahan ini bukan milik anda.'; log('forbidden', message, b.id); return reply(403, { message }); }
    db.prepare("UPDATE bookings SET status='Cancelled' WHERE id=?").run(b.id);
    broadcastBooking('cancelled', getBooking(b.id));
    const message = `Tempahan ${room.name} pada ${when} telah dibatalkan.`;
    log('cancelled', message, b.id);
    return reply(200, { message, booking_id: b.id });
  }

  if (!v.title) { const message = 'Tajuk mesyuarat diperlukan. ' + FORMAT_HELP; log('invalid', message); return reply(400, { message }); }
  if (v.start_at.slice(11, 16) < s.inbound_open || v.end_at.slice(11, 16) > s.inbound_close) {
    const message = `Tempahan di luar waktu operasi (${s.inbound_open}-${s.inbound_close}).`;
    log('outside_hours', message);
    return reply(409, { message, free_slots: [] });
  }
  const organizer = user ? user.name : sender;
  const check = validateBooking({ room_id: room.id, title: v.title, organizer, start_at: v.start_at, end_at: v.end_at });
  if (check.error) {
    const minutes = (parseLocal(v.end_at) - parseLocal(v.start_at)) / 60000;
    const slots = check.conflict ? freeSlots(room, v.date, minutes) : [];
    const c = check.clash;
    const reason = check.conflict
      ? `Bilik ${room.name} sudah ditempah ${c.start_at.slice(11, 16)}-${c.end_at.slice(11, 16)} (${c.title}).`
      : check.error;
    const message = reason + (check.conflict ? (slots.length ? ` Slot kosong pada tarikh tu: ${slots.join(', ')}.` : ' Tiada slot kosong pada tarikh tu.') : '');
    log(check.conflict ? 'conflict' : 'invalid', message);
    return reply(check.conflict ? 409 : 400, { message, free_slots: slots });
  }
  const info = db.prepare("INSERT INTO bookings(room_id,title,organizer,start_at,end_at,status,created_by) VALUES(?,?,?,?,?,'Pending',?)")
    .run(room.id, v.title, organizer, v.start_at, v.end_at, user ? user.id : null);
  const booking = getBooking(info.lastInsertRowid);
  broadcastBooking('created', booking);
  const message = `Tempahan ${room.name} pada ${when} telah diterima dan menunggu kelulusan.`;
  log('created', message, booking.id);
  return reply(201, { message, booking_id: booking.id, status: 'Pending' });
});
app.post('/api/settings/inbound-secret', (req, res) => {
  const secret = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('inbound_secret', JSON.stringify(secret));
  res.json({ inbound_secret: secret });
});
app.get('/api/inbound/log', (req, res) => res.json(db.prepare('SELECT * FROM inbound_log ORDER BY id DESC LIMIT 30').all()));

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
