// Full-screen tablet display. Page: display.html?code=DISPLAY-101
// Works offline: the last schedule is kept in localStorage, and the status is worked out from it on the device.
(function () {
  const A = window.RoomFlowAPI;
  const code = (new URLSearchParams(location.search).get('code') || '').toUpperCase();
  const CACHE_KEY = 'rf-display:' + code;
  const pad = n => String(n).padStart(2, '0');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const parse = s => new Date(String(s).replace(' ', 'T'));
  const stamp = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

  let settings = { time_format: '12', display_refresh_seconds: 15, system_name: 'RoomFlow' };
  let lastData = null, lastSavedAt = null, online = navigator.onLine, timer = null, socket = null;
  // Venue clock: the server's time, so the tablet is right even if its own timezone or clock is wrong.
  let offsetMs = 0;
  const venueNow = () => new Date(Date.now() + offsetMs);
  const root = document.getElementById('app');

  // ---------- connection indicator (small bar at the top)
  const bar = document.createElement('div');
  bar.id = 'netbar';
  document.body.appendChild(bar);
  function paintBar() {
    if (!code) return;
    const when = lastSavedAt ? `saved ${fmtTime(stamp(new Date(lastSavedAt + offsetMs)))}` : '';
    bar.className = online ? 'on' : 'off';
    bar.innerHTML = online
      ? `<i></i> Online`
      : `<i></i> Offline${when ? ' · ' + when : ''}`;
  }

  // ---------- formatting
  const fmtTime = s => {
    const d = parse(s);
    if (settings.time_format === '24') return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  };
  const fmtDay = s => parse(s).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });

  function clock() {
    const n = venueNow();
    const t = settings.time_format === '24' ? `${pad(n.getHours())}:${pad(n.getMinutes())}`
      : n.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    const d = n.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    const el = document.getElementById('clock');
    if (el) el.innerHTML = `<div class="time">${t}</div><div class="date">${d}</div>`;
  }

  function message(title, html) {
    root.innerHTML = `<div class="screen"><div class="screen-msg"><h2>${title}</h2><p>${html}</p></div></div>`;
  }

  // ---------- status from the schedule, computed on the device so it stays right even offline
  function derive(data) {
    const now = stamp(venueNow());
    const live = (data.schedule || []).filter(b => b.status !== 'Cancelled' && b.end_at > now)
      .sort((a, b) => a.start_at < b.start_at ? -1 : 1);
    const current = live.find(b => b.start_at <= now) || null;
    const upcoming = live.filter(b => b.start_at > now).slice(0, 1);
    return { current, upcoming };
  }

  function render(data) {
    const { room, device } = data;
    if (!room) {
      return message(esc(device?.device_name || code), 'This display is not assigned to a room yet.<br>Assign it on the Room Displays page of the admin console.');
    }
    const { current, upcoming } = derive(data);
    const next = upcoming[0];
    const state = current
      ? `<div class="state-card busy"><div class="label">IN USE</div><div class="big">${esc(current.title)}</div>
          <div class="sub2">${esc(current.organizer)} · ${fmtTime(current.start_at)} – ${fmtTime(current.end_at)}</div>
          <div class="sub2">${next ? `Free from ${fmtTime(current.end_at)} · next: ${esc(next.title)} at ${fmtTime(next.start_at)}` : `Free from ${fmtTime(current.end_at)}`}</div></div>`
      : `<div class="state-card free"><div class="label">AVAILABLE NOW</div><div class="big">Room is free</div>
          <div class="sub2">${next ? `Next booking at ${fmtTime(next.start_at)} · ${esc(next.title)}` : 'No more bookings scheduled'}</div></div>`;
    // layout (landscape / portrait) and design (classic / minimal / bold) come from the server
    const disp = data.display || { layout: 'landscape', template: 'classic' };
    const cls = `screen layout-${disp.layout} tpl-${disp.template} ${current ? 'is-busy' : 'is-free'}`;
    root.innerHTML = `<div class="${cls}">
      <div class="screen-head">
        <div><div class="code">ROOM ${esc(room.room_no)}${room.floor ? ' · ' + esc(room.floor) : ''}</div>
          <h1>${esc(room.name)}</h1><div class="loc">${room.capacity} seats · ${esc(settings.system_name)}</div></div>
        <div class="clock" id="clock"></div>
      </div>
      ${state}
    </div>`;
    clock();
  }

  function showData(data, { fromCache = false } = {}) {
    lastData = data;
    settings = { ...settings, ...(data.settings || {}) };
    render(data);
    paintBar();
  }

  // ---------- cache
  function saveCache(data) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt: Date.now(), data })); } catch (_) { /* storage full or disabled */ }
  }
  function loadCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY)); } catch (_) { return null; }
  }

  // ---------- refresh loop
  async function refresh() {
    clearTimeout(timer);
    try {
      const data = await A.getDisplay(code);
      online = true;
      lastSavedAt = Date.now();
      offsetMs = parse(data.server_now).getTime() - Date.now();
      saveCache({ ...data, offset: offsetMs });
      showData(data);
    } catch (e) {
      if (e.status === 404) {
        message(esc(code || '—'), `Device <code>${esc(code)}</code> is not registered. Register it on the admin console (Room Displays).`);
        paintBar();
      } else {
        // network down or server unreachable: fall back to the saved copy
        online = false;
        const cached = loadCache();
        if (cached && cached.data && cached.data.room) {
          lastSavedAt = cached.savedAt;
          offsetMs = cached.data.offset || 0;
          showData(cached.data, { fromCache: true });
        } else if (!lastData) {
          message('Offline', 'No saved schedule on this device yet. It will show the room as soon as it connects once.');
        }
        paintBar();
      }
    }
    timer = setTimeout(refresh, Math.min(15, Math.max(5, settings.display_refresh_seconds || 15)) * 1000);
  }

  // ---------- start
  if (!code) {
    message('No device code', 'Open this page as <code>display.html?code=DISPLAY-101</code>.');
  } else {
    setInterval(clock, 15000);
    // Re-check the status every 20s from the schedule, so a meeting that starts or ends while offline still updates
    setInterval(() => { if (lastData) showData(lastData); }, 20000);
    window.addEventListener('online', () => refresh());
    window.addEventListener('offline', () => { online = false; paintBar(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    window.addEventListener('focus', refresh);
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
    // show the saved copy straight away (before the first network call finishes)
    const cached = loadCache();
    if (cached && cached.data && cached.data.room) { lastSavedAt = cached.savedAt; offsetMs = cached.data.offset || 0; showData(cached.data); }
    refresh();
    if (typeof io === 'function') {
      socket = io({ reconnection: true });
      socket.on('connect', () => { online = true; socket.emit('display:join', { deviceCode: code }); paintBar(); });
      socket.on('disconnect', () => { online = false; paintBar(); });
      socket.on('display:ready', () => refresh());
      socket.on('display:refresh', () => refresh());
      socket.on('booking:changed', () => refresh());
      socket.on('settings:changed', s => { settings = { ...settings, ...s }; refresh(); });
    }
  }
})();
