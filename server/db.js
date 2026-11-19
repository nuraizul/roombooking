const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'roomflow.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS rooms (
 id INTEGER PRIMARY KEY AUTOINCREMENT, room_no TEXT NOT NULL UNIQUE,
 name TEXT NOT NULL, floor TEXT DEFAULT '', capacity INTEGER DEFAULT 0,
 facilities TEXT DEFAULT '[]', active INTEGER DEFAULT 1,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
 email TEXT NOT NULL UNIQUE, role TEXT DEFAULT 'Staff', active INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS bookings (
 id INTEGER PRIMARY KEY AUTOINCREMENT, room_id INTEGER NOT NULL,
 title TEXT NOT NULL, organizer TEXT NOT NULL, start_at TEXT NOT NULL,
 end_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Confirmed',
 created_at TEXT DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(room_id) REFERENCES rooms(id)
);
CREATE INDEX IF NOT EXISTS idx_bookings_room_time ON bookings(room_id, start_at, end_at);
CREATE TABLE IF NOT EXISTS devices (
 id INTEGER PRIMARY KEY AUTOINCREMENT, device_code TEXT NOT NULL UNIQUE,
 device_name TEXT NOT NULL, room_id INTEGER,
 platform TEXT DEFAULT 'Android', last_seen TEXT, active INTEGER DEFAULT 1,
 FOREIGN KEY(room_id) REFERENCES rooms(id)
);
CREATE TABLE IF NOT EXISTS settings (
 key TEXT PRIMARY KEY, value TEXT NOT NULL
);
`);
const count = db.prepare('SELECT COUNT(*) AS n FROM rooms').get().n;
if (!count) {
 const insert = db.prepare('INSERT INTO rooms(room_no,name,floor,capacity,facilities) VALUES(?,?,?,?,?)');
 const seed = db.transaction(() => {
  [['101','Meeting Room Alpha','Level 1',8,['Display','Wi-Fi']],['102','Meeting Room Beta','Level 1',12,['Display','Wi-Fi','Video']],['103','Meeting Room Gamma','Level 1',6,['Display']],['201','Conference Room','Level 2',20,['Display','HDMI']],['202','Meeting Room Delta','Level 2',10,['Display','Wi-Fi']],['203','Meeting Room Epsilon','Level 2',6,['Display']]].forEach(r=>insert.run(r[0],r[1],r[2],r[3],JSON.stringify(r[4])));
 }); seed();
}
module.exports = db;
