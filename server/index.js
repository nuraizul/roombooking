const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const ONLINE_WINDOW_MIN = 2;
const ROLES = ['Administrator', 'Staff'];
const DEFAULT_SETTINGS = {
  system_name: 'RoomFlow Booking System',
  organization: 'Your Organization',
  time_format: '12',
  default_duration: 60,
  buffer_minutes: 10,
  allow_same_day: true,
  require_approval: false,
  display_refresh_seconds: 30
};

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const seedSetting = db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) seedSetting.run(k, JSON.stringify(v));

// ---------- time helpers: bookings are stored as local "YYYY-MM-DD HH:MM:SS" so string compare works
const pad = n => String(n).padStart(2, '0');
const fmtLocal = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const nowStr = () => fmtLocal(new Date());
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
  io.to(`room:${booking.room_id}`).emit('booking:changed', { type, booking });
  if (oldRoomId && oldRoomId !== booking.room_id) io.to(`room:${oldRoomId}`).emit('booking:changed', { type, booking });
  io.emit('bookings:changed', { type, booking });
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
  const info = db.prepare('INSERT INTO bookings(room_id,title,organizer,start_at,end_at,status) VALUES(?,?,?,?,?,?)')
    .run(room_id, title, organizer, start_at, end_at, status);
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
  if (!device_code || !device_name) return bad(res, 'Device code and device name are required');
  if (!/^[A-Z0-9_-]{2,40}$/.test(device_code)) return bad(res, 'Device code may only use letters, numbers, - and _');
  if (room_id && !db.prepare('SELECT id FROM rooms WHERE id=? AND active=1').get(room_id)) return bad(res, 'Room not found', 404);
  try {
    const info = db.prepare('INSERT INTO devices(device_code,device_name,platform,room_id) VALUES(?,?,?,?)').run(device_code, device_name, platform, room_id);
    const device = db.prepare('SELECT * FROM devices WHERE id=?').get(info.lastInsertRowid);
    io.emit('devices:changed', device);
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
  io.emit('devices:changed', updated);
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
  const room = device.room_id ? db.prepare('SELECT * FROM rooms WHERE id=? AND active=1').get(device.room_id) : null;
  if (!room) return res.json({ device, room: null, current: null, upcoming: [], settings });
  const list = db.prepare(`${BOOKING_SQL} WHERE b.room_id=? AND b.status!='Cancelled' AND b.end_at>? ORDER BY b.start_at LIMIT 12`)
    .all(room.id, now).map(b => bookingShape(b, now));
  const current = list.find(b => b.time_state === 'Ongoing') || null;
  const upcoming = list.filter(b => b.time_state === 'Upcoming').slice(0, 6);
  res.json({ device, room: roomShape(room), current, upcoming, settings });
});

// ---------- users
function userInput(b) {
  const name = String(b.name || '').trim(), email = String(b.email || '').trim().toLowerCase();
  const role = ROLES.includes(b.role) ? b.role : 'Staff';
  if (!name || !email) return { error: 'Name and email are required' };
  if (name.length > 80) return { error: 'Name is too long' };
  if (!isEmail(email)) return { error: 'Email format is invalid' };
  return { value: { name, email, role } };
}
app.get('/api/users', (req, res) => res.json(db.prepare('SELECT * FROM users ORDER BY name').all().map(u => ({ ...u, active: !!u.active }))));
app.post('/api/users', (req, res) => {
  const v = userInput(req.body || {});
  if (v.error) return bad(res, v.error);
  try {
    const info = db.prepare('INSERT INTO users(name,email,role) VALUES(?,?,?)').run(v.value.name, v.value.email, v.value.role);
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid);
    io.emit('users:changed', user);
    res.status(201).json({ ...user, active: !!user.active });
  } catch (e) {
    if (isUnique(e)) return bad(res, 'Email already exists', 409);
    throw e;
  }
});
app.put('/api/users/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM users WHERE id=?').get(id)) return bad(res, 'User not found', 404);
  const v = userInput(req.body || {});
  if (v.error) return bad(res, v.error);
  try {
    db.prepare('UPDATE users SET name=?,email=?,role=? WHERE id=?').run(v.value.name, v.value.email, v.value.role, id);
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    io.emit('users:changed', user);
    res.json({ ...user, active: !!user.active });
  } catch (e) {
    if (isUnique(e)) return bad(res, 'Email already exists', 409);
    throw e;
  }
});
app.patch('/api/users/:id/active', (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM users WHERE id=?').get(id)) return bad(res, 'User not found', 404);
  const active = req.body?.active === true || req.body?.active === 'true';
  db.prepare('UPDATE users SET active=? WHERE id=?').run(active ? 1 : 0, id);
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  io.emit('users:changed', user);
  res.json({ ...user, active: !!user.active });
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
