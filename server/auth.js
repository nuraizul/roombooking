// Authentication, sessions, roles and route-level access control.
const crypto = require('crypto');
const db = require('./db');

const SESSION_HOURS = 12;

// ---------- schema (safe to run on existing databases)
db.exec(`CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL
);`);
const columnsOf = t => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
if (!columnsOf('users').includes('password_hash')) db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT');
if (!columnsOf('bookings').includes('created_by')) db.exec('ALTER TABLE bookings ADD COLUMN created_by INTEGER');

// ---------- roles & permissions (roles are stored in the database and managed by admins)
db.exec(`CREATE TABLE IF NOT EXISTS roles (
  name TEXT PRIMARY KEY, perms TEXT NOT NULL DEFAULT '[]', system INTEGER DEFAULT 0
);`);

// Every permission the app understands. Admins choose from this list when building roles.
const PERM_CATALOG = [
  { key: 'dashboard.view', label: 'View dashboard', group: 'Dashboard' },
  { key: 'rooms.view', label: 'View rooms', group: 'Rooms' },
  { key: 'rooms.manage', label: 'Add, edit and deactivate rooms', group: 'Rooms' },
  { key: 'bookings.view', label: 'View all bookings', group: 'Bookings' },
  { key: 'bookings.create', label: 'Create bookings', group: 'Bookings' },
  { key: 'bookings.edit_own', label: 'Edit and cancel own bookings', group: 'Bookings' },
  { key: 'bookings.manage', label: 'Edit and cancel any booking', group: 'Bookings' },
  { key: 'bookings.approve', label: 'Approve pending bookings', group: 'Bookings' },
  { key: 'calendar.view', label: 'View calendar', group: 'Calendar' },
  { key: 'users.manage', label: 'Manage users and passwords', group: 'Administration' },
  { key: 'roles.manage', label: 'Manage roles and permissions', group: 'Administration' },
  { key: 'devices.manage', label: 'Manage room displays', group: 'Administration' },
  { key: 'settings.manage', label: 'Change system settings', group: 'Administration' }
];
const ALL_PERMS = PERM_CATALOG.map(p => p.key);
const ADMIN_ROLE = 'Administrator';

// Seed the built-in roles on first run. Administrator always has every permission and cannot be edited.
db.prepare("INSERT OR IGNORE INTO roles(name,perms,system) VALUES(?,?,1)").run(ADMIN_ROLE, JSON.stringify(ALL_PERMS));
db.prepare("INSERT OR IGNORE INTO roles(name,perms,system) VALUES('Staff',?,0)").run(JSON.stringify([
  'dashboard.view', 'rooms.view', 'bookings.view', 'bookings.create', 'bookings.edit_own', 'calendar.view'
]));

function permsFor(roleName) {
  if (roleName === ADMIN_ROLE) return ALL_PERMS;
  const row = db.prepare('SELECT perms FROM roles WHERE name=?').get(roleName);
  return row ? JSON.parse(row.perms) : [];
}
const can = (user, perm) => !!user && permsFor(user.role).includes(perm);

// ---------- passwords (scrypt, built into Node)
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
function verifyPassword(pw, stored) {
  if (!stored || !pw) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(pw, salt, 64);
  const expect = Buffer.from(hash, 'hex');
  return expect.length === test.length && crypto.timingSafeEqual(test, expect);
}

// ---------- sessions
const getToken = req => {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)rf_session=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
};
function currentUser(req) {
  const t = getToken(req);
  if (!t) return null;
  const row = db.prepare(`SELECT u.id,u.name,u.email,u.role,u.active,s.expires_at
    FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?`).get(t);
  if (!row || !row.active || row.expires_at < Date.now()) return null;
  return { id: row.id, name: row.name, email: row.email, role: row.role };
}
function login(req, res, user) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());
  db.prepare('INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)').run(token, user.id, Date.now() + SESSION_HOURS * 3600 * 1000);
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `rf_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_HOURS * 3600}${secure}`);
}
function logout(req, res) {
  const t = getToken(req);
  if (t) db.prepare('DELETE FROM sessions WHERE token=?').run(t);
  res.setHeader('Set-Cookie', 'rf_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}
const publicUser = u => ({ id: u.id, name: u.name, email: u.email, role: u.role });
const withPerms = u => ({ ...u, permissions: permsFor(u.role) });
const hasAnyPassword = () => !!db.prepare("SELECT 1 FROM users WHERE password_hash IS NOT NULL AND password_hash!='' LIMIT 1").get();
const countActiveAdmins = () => db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='Administrator' AND active=1").get().n;

// ---------- route access rules: [method, path regex, permission or null (any logged-in user)]
const PUBLIC = [/^\/api\/health$/, /^\/api\/time$/, /^\/api\/auth\//, /^\/api\/display\//];
const RULES = [
  ['GET', /^\/api\/settings$/, null],
  ['PUT', /^\/api\/settings$/, 'settings.manage'],
  ['GET', /^\/api\/rooms(\/status)?$/, 'rooms.view'],
  ['GET', /^\/api\/floorplan$/, 'rooms.view'],
  ['PUT', /^\/api\/floorplan\/rooms$/, 'rooms.manage'],
  ['POST', /^\/api\/floorplan\/levels$/, 'rooms.manage'],
  ['PATCH', /^\/api\/floorplan\/levels\/[^/]+$/, 'rooms.manage'],
  ['DELETE', /^\/api\/floorplan\/levels\/[^/]+$/, 'rooms.manage'],
  ['POST', /^\/api\/rooms$/, 'rooms.manage'],
  ['PUT', /^\/api\/rooms\/\d+$/, 'rooms.manage'],
  ['PATCH', /^\/api\/rooms\/\d+\/active$/, 'rooms.manage'],
  ['GET', /^\/api\/bookings$/, 'bookings.view'],
  ['POST', /^\/api\/bookings$/, 'bookings.create'],
  ['PUT', /^\/api\/bookings\/(\d+)$/, 'bookings.edit_own'],
  ['PATCH', /^\/api\/bookings\/(\d+)\/cancel$/, 'bookings.edit_own'],
  ['PATCH', /^\/api\/bookings\/\d+\/approve$/, 'bookings.approve'],
  ['PATCH', /^\/api\/bookings\/\d+\/reject$/, 'bookings.approve'],
  ['GET', /^\/api\/devices$/, 'devices.manage'],
  ['POST', /^\/api\/devices\/register$/, 'devices.manage'],
  ['PATCH', /^\/api\/devices\/\d+\/assign$/, 'devices.manage'],
  ['DELETE', /^\/api\/devices\/\d+$/, 'devices.manage'],
  ['PATCH', /^\/api\/devices\/\d+\/display$/, 'devices.manage'],
  ['GET', /^\/api\/users$/, 'users.manage'],
  ['POST', /^\/api\/users$/, 'users.manage'],
  ['PUT', /^\/api\/users\/\d+$/, 'users.manage'],
  ['PATCH', /^\/api\/users\/\d+\/active$/, 'users.manage'],
  ['GET', /^\/api\/roles$/, null],
  ['POST', /^\/api\/roles$/, 'roles.manage'],
  ['PUT', /^\/api\/roles\/[^/]+$/, 'roles.manage'],
  ['DELETE', /^\/api\/roles\/[^/]+$/, 'roles.manage']
];

// Middleware for /api: checks login, then the role's permission. Staff may only change their own bookings.
function requireAccess(req, res, next) {
  const full = req.originalUrl.split('?')[0];
  if (PUBLIC.some(re => re.test(full))) return next();
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Please log in' });
  req.user = user;
  const rule = RULES.find(([m, re]) => m === req.method && re.test(full));
  if (!rule) return next(); // unknown route: the 404 handler answers
  const [, re, perm] = rule;
  if (perm === null) return next();
  if (perm === 'bookings.edit_own' && can(user, 'bookings.manage')) return next();
  if (!can(user, perm)) return res.status(403).json({ error: 'Your role is not allowed to do this' });
  if (perm === 'bookings.edit_own') {
    const b = db.prepare('SELECT created_by FROM bookings WHERE id=?').get(Number(full.match(re)[1]));
    if (!b) return next(); // route returns 404
    if (b.created_by !== user.id) return res.status(403).json({ error: 'You can only change bookings you created' });
  }
  next();
}

module.exports = {
  ALL_PERMS, PERM_CATALOG, ADMIN_ROLE, permsFor, can, hashPassword, verifyPassword,
  currentUser, login, logout, publicUser, withPerms, hasAnyPassword, countActiveAdmins, requireAccess
};
