const express = require('express');
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
  else if (b.end_at <= now) time_state = 'Completed';
  else if (b.start_at <= now) time_state = 'Ongoing';
  else time_state = 'Upcoming';
  return { ...b, time_state };
}
const getBooking = id => bookingShape(db.prepare(`${BOOKING_SQL} WHERE b.id=?`).get(id));

// ---------- booking rules
function findConflict(room_id, start, end, excludeId, buffer) {
  const from = addMin(start, -buffer), to = addMin(end, buffer);
  return db.prepare(`SELECT id,title,start_at,end_at FROM bookings
    WHERE room_id=? AND status!='Cancelled' AND id!=? AND start_at<? AND end_at>? LIMIT 1`)
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
  const upcoming = db.prepare(`${BOOKING_SQL} WHERE b.status!='Cancelled' AND b.end_at>? AND r.active=1 ORDER BY b.start_at`)
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
    const n = db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE room_id=? AND status!='Cancelled' AND end_at>?").get(id, nowStr()).n;
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
  const status = getSettings().require_approval ? 'Pending' : 'Confirmed';
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
  db.prepare('UPDATE bookings SET room_id=?,title=?,organizer=?,start_at=?,end_at=? WHERE id=?').run(room_id, title, organizer, start_at, end_at, id);
  const booking = getBooking(id);
  broadcastBooking('updated', booking, old.room_id);
  res.json(booking);
});
app.patch('/api/bookings/:id/cancel', (req, res) => {
  const id = Number(req.params.id);
  const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(id);
  if (!b) return bad(res, 'Booking not found', 404);
  if (b.status === 'Cancelled') return bad(res, 'Booking is already cancelled', 409);
  db.prepare("UPDATE bookings SET status='Cancelled' WHERE id=?").run(id);
  const booking = getBooking(id);
  broadcastBooking('cancelled', booking);
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
  const list = db.prepare(`${BOOKING_SQL} WHERE b.room_id=? AND b.status!='Cancelled' AND b.end_at>? ORDER BY b.start_at LIMIT 12`)
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
