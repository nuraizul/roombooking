// Shared admin shell + helpers. Page modules live in js/pages/*.js and register on RF.pages.
(function () {
  const A = window.RoomFlowAPI;
  const RF = (window.RF = { pages: {}, settings: { time_format: '12', system_name: 'RoomFlow Booking System', organization: 'Your Organization' } });
  const FACILITIES = ['Display', 'Wi-Fi', 'Video', 'HDMI', 'Whiteboard', 'Phone'];
  const NAV = [
    { id: 'dashboard', label: 'Dashboard', icon: 'fa-chart-pie', href: 'index.html', perm: 'dashboard.view' },
    { id: 'rooms', label: 'Rooms', icon: 'fa-door-open', href: 'rooms.html', perm: 'rooms.view' },
    { id: 'bookings', label: 'Bookings', icon: 'fa-calendar-check', href: 'bookings.html', perm: 'bookings.view' },
    { id: 'calendar', label: 'Calendar', icon: 'fa-calendar-days', href: 'calendar.html', perm: 'calendar.view' },
    { id: 'users', label: 'Users', icon: 'fa-users', href: 'users.html', perm: 'users.manage' },
    { id: 'roles', label: 'Roles', icon: 'fa-user-tag', href: 'roles.html', perm: 'roles.manage' },
    { id: 'display', label: 'Room Displays', icon: 'fa-display', href: 'room-display.html', perm: 'devices.manage' },
    { id: 'settings', label: 'Settings', icon: 'fa-gear', href: 'settings.html', perm: 'settings.manage' }
  ];
  const META = {
    dashboard: ['Dashboard', 'Live room status and today’s schedule.'],
    rooms: ['Rooms', 'Manage meeting rooms, capacity and facilities.'],
    bookings: ['Bookings', 'Create, edit, approve and cancel reservations.'],
    calendar: ['Calendar', 'Monthly view of all room bookings.'],
    users: ['Users', 'Manage user accounts and roles.'],
    roles: ['Roles', 'Create roles and choose what each role can access.'],
    display: ['Room Displays', 'Register tablets and assign them to rooms.'],
    settings: ['Settings', 'Booking rules and system configuration.']
  };

  const pad = n => String(n).padStart(2, '0');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  RF.esc = esc;
  RF.facilities = FACILITIES;
  RF.dateStr = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  RF.today = () => RF.dateStr(new Date());
  RF.parse = s => new Date(String(s).replace(' ', 'T'));
  RF.fmtDate = s => RF.parse(s).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  RF.fmtTime = s => {
    const d = RF.parse(s);
    if (RF.settings.time_format === '24') return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  };
  RF.timeRange = b => `${RF.fmtTime(b.start_at)} – ${RF.fmtTime(b.end_at)}`;
  RF.addMinutesStr = (dateTime, m) => { const d = new Date(dateTime.getTime() + m * 60000); return d; };

  RF.statePill = b => {
    const map = {
      Pending: ['orange', 'Pending approval'],
      Cancelled: ['red', 'Cancelled'],
      Ongoing: ['green', 'Ongoing'],
      Upcoming: ['blue', 'Upcoming'],
      Completed: ['gray', 'Completed'],
      Rejected: ['red', 'Rejected']
    };
    const key = b.status === 'Pending' ? 'Pending' : b.time_state;
    const [cls, label] = map[key] || map.Upcoming;
    return `<span class="pill ${cls}">${label}</span>`;
  };

  RF.facilityChecks = (selected = []) => FACILITIES.map(f =>
    `<label class="check"><input type="checkbox" name="facilities[]" value="${f}" ${selected.includes(f) ? 'checked' : ''}> ${f}</label>`).join('');

  RF.roomCard = (r, actions = '') => {
    const occ = r.status === 'Occupied';
    const foot = occ
      ? `<span>Ends ${RF.fmtTime(r.current.end_at)}</span><b>${esc(r.current.title)}</b>`
      : r.next ? `<span>Next booking</span><b>${RF.fmtTime(r.next.start_at)} · ${RF.fmtDate(r.next.start_at)}</b>`
        : `<span>Next booking</span><b>None scheduled</b>`;
    return `<article class="room-card">
      <div class="room-top"><span class="badge ${occ ? 'busy' : ''}"><i class="dot"></i>${occ ? 'Occupied' : 'Available'}</span></div>
      <div class="room-code">ROOM ${esc(r.room_no)}</div>
      <h3>${esc(r.name)}</h3>
      <div class="room-meta"><span><i class="fa-solid fa-user-group"></i>${r.capacity} seats</span><span><i class="fa-solid fa-location-dot"></i>${esc(r.floor || '—')}</span></div>
      <div class="chiprow">${(r.facilities || []).map(f => `<span class="chip">${esc(f)}</span>`).join('')}</div>
      <div class="card-foot">${foot}</div>
      ${actions ? `<div class="card-actions">${actions}</div>` : ''}
    </article>`;
  };

  RF.toast = (msg, type = 'ok') => {
    let box = document.getElementById('toasts');
    if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  };

  RF.modal = ({ title, body, width = 560, onMount }) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `<div class="modal" style="max-width:${width}px" role="dialog" aria-modal="true">
      <div class="modal-head"><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div>
      <div class="modal-body">${body}</div></div>`;
    document.body.appendChild(wrap);
    const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    wrap.addEventListener('click', e => { if (e.target === wrap || e.target.closest('[data-close]')) close(); });
    onMount && onMount(wrap.querySelector('.modal-body'), close);
    return { close, root: wrap };
  };

  RF.readForm = form => {
    const out = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      if (el.type === 'checkbox' && el.name.endsWith('[]')) {
        const key = el.name.slice(0, -2);
        out[key] = out[key] || [];
        if (el.checked) out[key].push(el.value);
      } else if (el.type === 'checkbox') {
        out[el.name] = el.checked;
      } else {
        out[el.name] = el.value.trim();
      }
    }
    return out;
  };

  RF.confirm = msg => window.confirm(msg);

  // Booking create/edit modal, shared by dashboard, bookings and calendar.
  RF.openBooking = async ({ booking = null, date, roomId, onSaved } = {}) => {
    const [rooms, users] = await Promise.all([A.getRooms(), A.getUsers().catch(() => [])]);
    const s = RF.settings;
    let startVal, endVal;
    if (booking) {
      startVal = booking.start_at.slice(0, 16).replace(' ', 'T');
      endVal = booking.end_at.slice(0, 16).replace(' ', 'T');
    } else {
      const base = new Date();
      let start = date && date !== RF.today() ? new Date(date + 'T09:00:00') : new Date(base);
      if (!date || date === RF.today()) {
        start.setMinutes(Math.ceil(base.getMinutes() / 30) * 30, 0, 0);
      }
      const end = new Date(start.getTime() + (s.default_duration || 60) * 60000);
      const fmt = d => `${RF.dateStr(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      startVal = fmt(start);
      endVal = fmt(end);
    }
    const roomOpts = rooms.map(r => `<option value="${r.id}" ${(booking ? booking.room_id : roomId) == r.id ? 'selected' : ''}>${esc(r.room_no)} · ${esc(r.name)}</option>`).join('');
    const orgList = users.filter(u => u.active).map(u => `<option value="${esc(u.name)}">`).join('');
    const body = `<form id="bform" class="form-grid" novalidate>
      <div class="field full"><label>Meeting title</label><input name="title" maxlength="120" required value="${esc(booking?.title || '')}" placeholder="e.g. Project sync"></div>
      <div class="field"><label>Room</label><select name="room_id" required>${roomOpts}</select></div>
      <div class="field"><label>Organizer</label><input name="organizer" list="org-list" maxlength="80" required value="${esc(booking?.organizer || '')}"><datalist id="org-list">${orgList}</datalist></div>
      <div class="field"><label>Start</label><input type="datetime-local" name="start_at" step="300" required value="${startVal}"></div>
      <div class="field"><label>End</label><input type="datetime-local" name="end_at" step="300" required value="${endVal}"></div>
      <div class="field full"><div class="form-error" id="bform-err"></div></div>
      <div class="field full modal-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">${booking ? 'Save changes' : 'Create booking'}</button></div>
    </form>`;
    RF.modal({
      title: booking ? 'Edit booking' : 'New booking',
      body,
      onMount: (root, close) => {
        const form = root.querySelector('#bform');
        const err = root.querySelector('#bform-err');
        form.addEventListener('submit', async e => {
          e.preventDefault();
          const v = RF.readForm(form);
          const payload = { room_id: Number(v.room_id), title: v.title, organizer: v.organizer, start_at: v.start_at, end_at: v.end_at };
          err.textContent = '';
          try {
            const saved = booking ? await A.updateBooking(booking.id, payload) : await A.createBooking(payload);
            RF.toast(saved.status === 'Pending' ? 'Sent for approval. The room is held until it is approved.' : (booking ? 'Booking updated' : 'Booking created'));
            close();
            onSaved && onSaved();
          } catch (ex) {
            err.textContent = ex.message;
          }
        });
      }
    });
  };

  // Permissions come from the server. Elements marked data-need are removed when the user lacks the permission.
  // data-owner (a booking's creator id) lets staff act only on their own bookings.
  function applyPerms(root) {
    root.querySelectorAll('[data-need]').forEach(el => {
      const need = el.dataset.need;
      let ok = RF.can(need);
      if (need === 'bookings.edit_own') ok = RF.can('bookings.manage') || (RF.can('bookings.edit_own') && String(RF.me.id) === el.dataset.owner);
      if (!ok) el.remove();
    });
  }

  function shell(page) {
    const [title, desc] = META[page] || META.dashboard;
    const nav = NAV.filter(n => RF.can(n.perm)).map(n => `<a href="${n.href}" class="${n.id === page ? 'active' : ''}"><i class="fa-solid ${n.icon}"></i><span>${n.label}</span></a>`).join('');
    document.getElementById('app').innerHTML = `<div class="shell">
      <aside class="sidebar">
        <div class="brand"><div class="brand-mark"><i class="fa-solid fa-calendar-check"></i></div><div><h2>RoomFlow</h2><small>${esc(RF.settings.system_name)}</small></div></div>
        <div class="nav-caption">WORKSPACE</div>
        <nav class="nav">${nav}</nav>
        <div class="sidebar-foot"><div class="avatar"><i class="fa-solid fa-user-shield"></i></div><div><strong>${esc(RF.settings.organization)}</strong><small>${esc(RF.me.role)} console</small></div></div>
      </aside>
      <main class="main">
        <header class="topbar">
          <div class="mobile-brand"><i class="fa-solid fa-calendar-check" style="color:var(--blue)"></i> RoomFlow</div>
          <div class="crumb">Workspace &nbsp;›&nbsp; <b>${title}</b></div>
          <div class="top-right">
            <span class="online-pill" id="conn"><i class="dot"></i> <span>Connecting…</span></span>
            <button class="btn small theme-btn" id="theme" title="Switch light / dark mode"><i class="fa-solid fa-moon"></i></button>
            <button class="btn small" id="pwd" title="Change password"><i class="fa-solid fa-key"></i></button>
            <span class="who">${esc(RF.me.name)} <small>${esc(RF.me.role)}</small></span>
            <button class="btn small" id="logout"><i class="fa-solid fa-right-from-bracket"></i> Logout</button>
          </div>
        </header>
        <div class="page">
          <div class="page-head"><div><h1>${title}</h1><p>${desc}</p></div></div>
          <div id="content"><div class="panel empty">Loading…</div></div>
          <footer class="footnote">© 2026 ${esc(RF.settings.organization)} · RoomFlow</footer>
        </div>
      </main></div>`;
  }

  function setConn(ok) {
    const el = document.getElementById('conn');
    if (!el) return;
    el.className = 'online-pill' + (ok ? '' : ' offline');
    el.querySelector('span').textContent = ok ? 'Live' : 'Offline';
  }

  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

  function changePassword() {
    RF.modal({
      title: 'Change password',
      body: `<form class="form-grid" id="pf" novalidate>
        <div class="field full"><label>Current password</label><input type="password" name="current" required></div>
        <div class="field full"><label>New password (min 8 characters)</label><input type="password" name="new" required minlength="8"></div>
        <div class="field full"><div class="form-error" id="perr"></div></div>
        <div class="field full modal-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Update</button></div>
      </form>`,
      onMount: (root, close) => {
        const f = root.querySelector('#pf');
        f.onsubmit = async e => {
          e.preventDefault();
          try { await A.request('/auth/password', { method: 'POST', body: RF.readForm(f) }); RF.toast('Password updated'); close(); }
          catch (ex) { root.querySelector('#perr').textContent = ex.message; }
        };
      }
    });
  }

  async function boot() {
    const page = document.body.dataset.page;
    try { RF.me = await A.request('/auth/me'); }
    catch (_) { location.href = 'login.html'; return; }
    RF.can = p => (RF.me.permissions || []).includes(p);
    try { RF.settings = await A.getSettings(); } catch (_) { /* keep defaults */ }
    shell(page);
    document.getElementById('logout').onclick = async () => {
      try { await A.request('/auth/logout', { method: 'POST' }); } catch (_) {}
      location.href = 'login.html';
    };
    document.getElementById('pwd').onclick = changePassword;
    const themeBtn = document.getElementById('theme');
    const paintTheme = () => { themeBtn.innerHTML = `<i class="fa-solid fa-${document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon'}"></i>`; };
    paintTheme();
    themeBtn.onclick = () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      localStorage.setItem('rf-theme', next);
      paintTheme();
    };
    new MutationObserver(() => applyPerms(document.body)).observe(document.body, { childList: true, subtree: true });
    const mod = RF.pages[page];
    if (!mod) return;
    const navItem = NAV.find(n => n.id === page);
    const content = document.getElementById('content');
    if (navItem && !RF.can(navItem.perm)) {
      content.innerHTML = `<div class="panel empty"><i class="fa-solid fa-lock"></i> Your role (${RF.esc(RF.me.role)}) does not have access to this page.</div>`;
      return;
    }
    const reload = debounce(() => mod.load && mod.load().catch(e => RF.toast(e.message, 'error')), 200);
    try {
      await mod.init(content);
    } catch (e) {
      content.innerHTML = `<div class="panel empty"><i class="fa-solid fa-triangle-exclamation"></i> Could not load this page: ${esc(e.message)}</div>`;
    }
    // Status changes with time (meeting start/end), not only on events, so refresh periodically too.
    setInterval(() => { if (!document.hidden) reload(); }, 30000);
    if (typeof io === 'function') {
      const socket = io();
      socket.on('connect', () => setConn(true));
      socket.on('disconnect', () => setConn(false));
      socket.on('settings:changed', s => { RF.settings = s; reload(); });
      (mod.events || []).forEach(ev => socket.on(ev, reload));
    }
  }
  RF.boot = boot;
  document.addEventListener('DOMContentLoaded', boot);
})();
