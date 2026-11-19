// Full-screen tablet display. Standalone page: display.html?code=DISPLAY-101
(function () {
  const A = window.RoomFlowAPI;
  const code = new URLSearchParams(location.search).get('code') || '';
  const pad = n => String(n).padStart(2, '0');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const parse = s => new Date(s.replace(' ', 'T'));
  let settings = { time_format: '12', display_refresh_seconds: 30, system_name: 'RoomFlow' };
  let timer = null, socket = null;
  const root = document.getElementById('app');

  const fmtTime = s => {
    const d = parse(s);
    if (settings.time_format === '24') return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  };
  const localToday = () => { const n = new Date(); return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`; };
  const fmtDay = s => parse(s).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });

  function clock() {
    const n = new Date();
    const t = settings.time_format === '24' ? `${pad(n.getHours())}:${pad(n.getMinutes())}`
      : n.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    const d = n.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    const el = document.getElementById('clock');
    if (el) el.innerHTML = `<div class="time">${t}</div><div class="date">${d}</div>`;
  }

  function message(title, html) {
    root.innerHTML = `<div class="screen"><div class="screen-msg"><h2>${title}</h2><p>${html}</p></div></div>`;
  }

  function render(data) {
    if (!data.room) {
      return message(esc(data.device?.device_name || code), `This display is not assigned to a room yet.<br>Assign it on the Room Displays page of the admin console.`);
    }
    const { room, current, upcoming } = data;
    const next = upcoming[0];
    const state = current
      ? `<div class="state-card busy"><div class="label">IN USE</div><div class="big">${esc(current.title)}</div>
          <div class="sub2">${esc(current.organizer)} · ${fmtTime(current.start_at)} – ${fmtTime(current.end_at)}</div>
          <div class="sub2">${next ? `Free from ${fmtTime(current.end_at)} · next: ${esc(next.title)} at ${fmtTime(next.start_at)}` : `Free from ${fmtTime(current.end_at)}`}</div></div>`
      : `<div class="state-card free"><div class="label">AVAILABLE NOW</div><div class="big">Room is free</div>
          <div class="sub2">${next ? `Next booking at ${fmtTime(next.start_at)} · ${esc(next.title)}` : 'No more bookings scheduled'}</div></div>`;
    const list = upcoming.length ? `<div class="up-list"><h3>UPCOMING</h3>${upcoming.map(b => `
        <div class="up-row"><div class="t">${fmtTime(b.start_at)} – ${fmtTime(b.end_at)}</div>
        <div>${esc(b.title)}</div><div class="o">${esc(b.organizer)}${b.start_at.slice(0, 10) !== localToday() ? ' · ' + fmtDay(b.start_at) : ''}</div></div>`).join('')}</div>` : '';
    root.innerHTML = `<div class="screen">
      <div class="screen-head">
        <div><div class="code">ROOM ${esc(room.room_no)}${room.floor ? ' · ' + esc(room.floor) : ''}</div>
          <h1>${esc(room.name)}</h1><div class="loc">${room.capacity} seats · ${esc(settings.system_name)}</div></div>
        <div class="clock" id="clock"></div>
      </div>
      ${state}
      ${list}
    </div>`;
    clock();
  }

  async function refresh() {
    try {
      const data = await A.getDisplay(code);
      settings = { ...settings, ...data.settings };
      render(data);
      schedule();
    } catch (e) {
      message('Display offline', `${esc(e.message)}<br>Device code <code>${esc(code || '—')}</code>. Register it on the admin console (Room Displays). Retrying…`);
      setTimeout(refresh, 15000);
    }
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(refresh, Math.max(5, settings.display_refresh_seconds || 30) * 1000);
  }

  if (!code) {
    message('No device code', 'Open this page as <code>display.html?code=DISPLAY-101</code>.');
  } else {
    setInterval(clock, 15000);
    refresh();
    if (typeof io === 'function') {
      socket = io();
      socket.on('connect', () => socket.emit('display:join', { deviceCode: code }));
      socket.on('display:ready', () => refresh());
      socket.on('display:refresh', () => refresh());
      socket.on('booking:changed', () => refresh());
      socket.on('settings:changed', s => { settings = { ...settings, ...s }; refresh(); });
    }
  }
})();
