// Builds the Teams app package (RoomFlow-Teams.zip) for your Railway address.
// Usage:  node build.js https://roomflow-xxx.up.railway.app
// Needs only Node.js. Upload the produced zip in Teams (Apps > Manage your apps > Upload a custom app).
const fs = require('fs');
const path = require('path');

const input = process.argv[2];
if (!input) { console.error('Usage: node build.js https://your-railway-address'); process.exit(1); }
const host = input.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) { console.error('That address does not look right: ' + input); process.exit(1); }

const dir = __dirname;
const out = path.join(dir, 'build');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out);

const manifest = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8').split('{{HOST}}').join(host);
JSON.parse(manifest); // makes sure the result is valid JSON
fs.writeFileSync(path.join(out, 'manifest.json'), manifest);
fs.copyFileSync(path.join(dir, 'color.png'), path.join(out, 'color.png'));
fs.copyFileSync(path.join(dir, 'outline.png'), path.join(out, 'outline.png'));

// ---- minimal ZIP writer (no compression, no dependencies)
const CRC_TABLE = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = buf => { let c = 0xFFFFFFFF; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
const now = new Date();
const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
function makeZip(files) {
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8'), data = f.data, crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, name, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0, 8); cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(dosTime, 12); cd.writeUInt16LE(dosDate, 14); cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += 30 + name.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}
const files = ['manifest.json', 'color.png', 'outline.png'].map(n => ({ name: n, data: fs.readFileSync(path.join(out, n)) }));
const zipPath = path.join(dir, 'RoomFlow-Teams.zip');
fs.writeFileSync(zipPath, makeZip(files));
console.log('Built: ' + zipPath);
console.log('Upload this file in Teams. Address used: https://' + host);
