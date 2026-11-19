# RoomFlow — Room Booking System

Full-stack room booking: Express API, SQLite database (better-sqlite3), Socket.IO live updates, and a vanilla HTML/CSS/JS admin console plus a full-screen tablet display.

## Requirements
- Node.js 20.10+ (Node.js 22 LTS recommended)
- npm

## Run
1. Extract the folder and open a terminal in it.
2. `npm install` (installs the native SQLite module for your OS).
3. `npm start`
4. Open `http://localhost:3000`. Do not open the HTML files directly.

The database is created at `data/roomflow.sqlite` on first run. Six sample rooms and default settings are seeded automatically.

To use another port: `PORT=8080 npm start` (Windows PowerShell: `$env:PORT=8080; npm start`).

## Pages
| Page | File | What it does |
| --- | --- | --- |
| Dashboard | `index.html` | Live room status, today's bookings, quick "New booking" |
| Rooms | `rooms.html` | Add, edit, deactivate rooms; facilities; search and floor filter |
| Bookings | `bookings.html` | Create, edit, approve, cancel; filter by date/room/status; CSV export |
| Calendar | `calendar.html` | Month view; click a day to see or add bookings |
| Users | `users.html` | Add, edit, enable/disable users; Administrator or Staff role |
| Room Displays | `room-display.html` | Register tablets, assign each to a room (live), remove devices |
| Settings | `settings.html` | System name, time format, default duration, buffer, same-day and approval rules, display refresh |
| Tablet display | `display.html?code=DISPLAY-101` | Full-screen room status (Available / In use), current meeting, upcoming list |

## Booking rules (enforced by the server)
- End time must be after start; minimum 5 minutes, maximum 12 hours.
- No booking in the past. Same-day booking can be turned off in Settings.
- No double booking. The configured buffer is kept between meetings (both sides).
- Cancelled bookings free the room immediately. Cancelled bookings cannot be edited.
- With "Require approval" on, new bookings are `Pending` (they still block the room) until an admin approves them.

## Tablet setup (Android/iOS browser)
1. On the admin console, open **Room Displays**, register a device code such as `DISPLAY-101` and assign it to a room.
2. On the tablet, open `http://<server-ip>:3000/display.html?code=DISPLAY-101` in full-screen or kiosk mode.
3. The tablet refreshes every N seconds (Settings) and immediately when a booking changes or the room assignment changes.
4. A device is "Online" when it has contacted the server in the last 2 minutes.

Host the server on a PC on the same network, allow TCP port 3000 through the firewall, and use that PC's LAN IP on the tablets.

## API
All endpoints are under `/api`. Dates use local time, format `YYYY-MM-DDTHH:MM`.

- `GET /api/health`
- `GET|PUT /api/settings`
- `GET /api/rooms`, `GET /api/rooms/status` (with current and next booking)
- `POST /api/rooms`, `PUT /api/rooms/:id`, `PATCH /api/rooms/:id/active` `{active}`
- `GET /api/bookings?from=YYYY-MM-DD&to=YYYY-MM-DD&room_id&status&q`
- `POST /api/bookings`, `PUT /api/bookings/:id`
- `PATCH /api/bookings/:id/cancel`, `PATCH /api/bookings/:id/approve`
- `GET /api/devices`, `POST /api/devices/register`, `PATCH /api/devices/:id/assign` `{room_id}`, `DELETE /api/devices/:id`
- `GET /api/display/:deviceCode`
- `GET /api/users`, `POST /api/users`, `PUT /api/users/:id`, `PATCH /api/users/:id/active`

Example:
```bash
curl -X POST http://localhost:3000/api/bookings -H "Content-Type: application/json" \
  -d '{"room_id":1,"title":"Project Meeting","organizer":"Nuraizul","start_at":"2026-11-20T10:00","end_at":"2026-11-20T11:00"}'
```

Realtime (Socket.IO): events `bookings:changed`, `booking:changed`, `rooms:changed`, `users:changed`, `devices:changed`, `settings:changed`.

## Front-end code layout
- `public/js/api-client.js` — `RoomFlowAPI`, a fetch wrapper for every endpoint.
- `public/js/app.js` — shared shell (sidebar, header, live indicator), modals, toasts, the booking form, and helpers on `window.RF`.
- `public/js/pages/*.js` — one module per admin page.
- `public/js/display.js` — tablet display.
- `public/css/style.css` (base theme) and `public/css/components.css` (modals, pills, calendar, display).

## Tablet display: online/offline and offline mode
- A small pill at the top right shows **Online** (green) or **Offline · saved HH:MM** (orange).
- The tablet keeps its last schedule in the browser, and a service worker (`sw.js`) keeps the display page and its scripts available. If the network drops, the room status keeps working from that saved schedule, and the status changes on time by itself.
- Open the display URL once while online so the page and schedule are saved on the tablet. After that it can start without a network.
- The display uses the server's clock, so the status stays right even if the tablet's timezone is wrong.
- Offline mode cannot show new bookings made after the tablet went offline. It shows the room as Available or In use based on the last schedule it received.

## Display layout and design
- **Settings → Display defaults**: choose the default **layout** (Landscape or Portrait) and **design** (Classic, Minimal or Bold) for all room displays.
- **Room Displays**: each tablet has its own **Layout** and **Design** dropdown. Choose "Default" to follow Settings, or pick one to override it for that tablet. Changes reach the tablet immediately.
- **Classic**: the dark look with a coloured status card.
- **Minimal**: light background, plain card, large text.
- **Bold**: the whole screen is green when the room is free and orange when it is in use.
- Layout only arranges the content. To lock the physical tablet to portrait or landscape, turn off auto-rotate on the tablet or set orientation in the app.

## Booking approval
- **Settings → Approve pending booking**: turn the feature ON or OFF with one switch. OFF means every booking is confirmed straight away.
- **Who can approve** is set on the **Roles** page: tick **Approve pending bookings** on a role. Administrator always has it. Roles with this permission book without waiting.
- When ON, bookings from roles without that permission start as **Pending** and hold the room until an approver acts on the Bookings page (Approve, or Reject with an optional reason).
- The **tablet display only shows confirmed meetings**. Pending requests are not shown there until they are approved.
- A **rejected** booking frees the room. The person who booked can edit it to send it for approval again.

## Login and roles
- First visit: if no account exists, the login page asks you to create the first **Administrator**.
- **Roles page** (Administrators only): create roles and tick what each role can access. The built-in Administrator role always has everything.
- The built-in **Staff** role can view dashboard, rooms, bookings and calendar, create bookings, and edit or cancel only bookings they created. You can edit it like any other role.
- Assign a role to a user in **Users**. Users only see the pages and buttons their role allows.
- Every API call checks the session and the role on the server, so hidden buttons cannot be bypassed.
- Users change their own password from the key icon in the top bar. Administrators set passwords in **Users**.
- Tablet displays (`display.html`) stay public so they can run without a login. Anyone with the display URL can see room status and meeting titles.
- Bookings created before this version have no creator, so only Administrators can change them.
- Sessions last 12 hours. Logout is in the top bar.

Not included yet: password reset by email, login rate limiting, and two-factor login.

## Not included yet
- HTTPS, recurring bookings, email/push notifications, and a production deployment setup.
