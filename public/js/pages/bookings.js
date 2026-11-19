(function () {
  const A = window.RoomFlowAPI, RF = window.RF;
  const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return RF.dateStr(d); };
  RF.pages.bookings = {
    events: ['bookings:changed', 'rooms:changed'],
    items: [],
    async init(el) {
      this.el = el;
      el.innerHTML = `
        <div class="stats stat-grid-4" id="stats"></div>
        <section class="panel">
          <div class="panel-head"><div><h2>All bookings</h2><p>Reservation records</p></div>
            <div class="actions"><button class="btn" id="csv"><i class="fa-solid fa-file-csv"></i> Export CSV</button>
            <button class="btn primary" id="new"><i class="fa-solid fa-plus"></i> New booking</button></div></div>
          <div class="toolbar">
            <div class="search"><i class="fa-solid fa-magnifying-glass"></i><input id="q" placeholder="Search title, room or organizer"></div>
            <input type="date" id="from" value="${addDays(0)}" title="From">
            <input type="date" id="to" value="${addDays(7)}" title="To">
            <select id="room"><option value="">All rooms</option></select>
            <select id="status"><option value="">All statuses</option><option>Upcoming</option><option>Ongoing</option><option>Completed</option><option>Pending</option><option>Cancelled</option></select>
          </div>
          <div class="table-wrap" id="table"></div>
        </section>`;
      ['q', 'room', 'status'].forEach(id => el.querySelector('#' + id).oninput = () => this.render());
      ['from', 'to'].forEach(id => el.querySelector('#' + id).onchange = () => this.load());
      el.querySelector('#new').onclick = () => RF.openBooking({ onSaved: () => this.load() });
      el.querySelector('#csv').onclick = () => this.exportCsv();
      const rooms = await A.getRooms();
      el.querySelector('#room').insertAdjacentHTML('beforeend', rooms.map(r => `<option value="${r.id}">${RF.esc(r.room_no)} · ${RF.esc(r.name)}</option>`).join(''));
      await this.load();
    },
    async load() {
      const from = this.el.querySelector('#from').value, to = this.el.querySelector('#to').value;
      this.items = await A.getBookings({ from, to });
      this.renderStats();
      this.render();
    },
    renderStats() {
      const t = RF.today(), list = this.items.filter(b => b.start_at.startsWith(t));
      const count = s => list.filter(b => (b.status === 'Pending' ? 'Pending' : b.time_state) === s).length;
      this.el.querySelector('#stats').innerHTML = [
        ['Today', list.filter(b => b.status !== 'Cancelled').length, 'Bookings today', 'fa-calendar-check', ''],
        ['Upcoming', count('Upcoming'), 'Still to come today', 'fa-clock', 'orange'],
        ['Completed', count('Completed'), 'Finished today', 'fa-check', 'green'],
        ['Cancelled', count('Cancelled'), 'Cancelled today', 'fa-ban', 'red']
      ].map(([a, v, f, i, k]) => `<div class="stat"><div class="stat-row"><span>${a}</span><span class="stat-icon ${k}"><i class="fa-solid ${i}"></i></span></div><h2>${v}</h2><small>${f}</small></div>`).join('');
    },
    filtered() {
      const q = this.el.querySelector('#q').value.toLowerCase();
      const room = this.el.querySelector('#room').value, st = this.el.querySelector('#status').value;
      return this.items.filter(b => {
        const state = b.status === 'Pending' ? 'Pending' : b.time_state;
        return (!room || String(b.room_id) === room) && (!st || state === st) &&
          (!q || `${b.title} ${b.organizer} ${b.room_no} ${b.room_name}`.toLowerCase().includes(q));
      });
    },
    render() {
      const list = this.filtered();
      const rows = list.map(b => `<tr>
        <td><strong>${RF.esc(b.title)}</strong><div class="muted">${RF.esc(b.organizer)}</div></td>
        <td>${RF.esc(b.room_no)} · ${RF.esc(b.room_name)}</td>
        <td>${RF.fmtDate(b.start_at)}</td>
        <td>${RF.timeRange(b)}</td>
        <td>${RF.statePill(b)}</td>
        <td><div class="table-actions">
          ${b.status === 'Pending' ? `<button class="btn small" data-approve="${b.id}">Approve</button>` : ''}
          ${b.time_state !== 'Cancelled' && b.time_state !== 'Completed' ? `<button class="btn small" data-edit="${b.id}">Edit</button>
          <button class="btn small danger" data-cancel="${b.id}">Cancel</button>` : ''}
        </div></td></tr>`).join('');
      this.el.querySelector('#table').innerHTML = list.length
        ? `<table><thead><tr><th>Meeting</th><th>Room</th><th>Date</th><th>Time</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
        : '<div class="empty">No bookings in this range.</div>';
      const find = id => this.items.find(b => b.id == id);
      this.el.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => RF.openBooking({ booking: find(b.dataset.edit), onSaved: () => this.load() }));
      this.el.querySelectorAll('[data-cancel]').forEach(b => b.onclick = async () => {
        if (!RF.confirm('Cancel this booking?')) return;
        try { await A.cancelBooking(b.dataset.cancel); RF.toast('Booking cancelled'); this.load(); } catch (e) { RF.toast(e.message, 'error'); }
      });
      this.el.querySelectorAll('[data-approve]').forEach(b => b.onclick = async () => {
        try { await A.approveBooking(b.dataset.approve); RF.toast('Booking approved'); this.load(); } catch (e) { RF.toast(e.message, 'error'); }
      });
    },
    exportCsv() {
      const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const head = ['Title', 'Organizer', 'Room', 'Date', 'Start', 'End', 'Status'];
      const lines = this.filtered().map(b => [b.title, b.organizer, `${b.room_no} ${b.room_name}`, b.start_at.slice(0, 10), b.start_at.slice(11, 16), b.end_at.slice(11, 16), b.status === 'Pending' ? 'Pending' : b.time_state].map(esc).join(','));
      const blob = new Blob([[head.join(','), ...lines].join('\n')], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = `bookings-${RF.today()}.csv`; a.click();
    }
  };
})();
