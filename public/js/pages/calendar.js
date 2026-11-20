(function () {
  const A = window.RoomFlowAPI, RF = window.RF;
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  RF.pages.calendar = {
    events: ['bookings:changed'],
    cursor: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
    bookings: [],
    async init(el) {
      this.el = el;
      el.innerHTML = `
        <section class="panel">
          <div class="panel-head">
            <div><h2 id="mlabel"></h2><p>Click a day to see or add bookings</p></div>
            <div class="actions">
              <label class="check" style="margin-right:6px"><input type="checkbox" id="mine"> My calendar</label>
              <select id="room"><option value="">All rooms</option></select>
              <button class="btn" id="prev"><i class="fa-solid fa-chevron-left"></i></button>
              <button class="btn" id="today">Today</button>
              <button class="btn" id="next"><i class="fa-solid fa-chevron-right"></i></button>
              <button class="btn primary" id="new" data-need="bookings.create"><i class="fa-solid fa-plus"></i> New booking</button>
            </div>
          </div>
          <div class="calendar-grid" id="grid"></div>
        </section>`;
      const rooms = await A.getRooms();
      el.querySelector('#room').insertAdjacentHTML('beforeend', rooms.map(r => `<option value="${r.id}">${RF.esc(r.room_no)} · ${RF.esc(r.name)}</option>`).join(''));
      el.querySelector('#room').onchange = () => this.load();
      el.querySelector('#mine').onchange = () => this.load();
      el.querySelector('#prev').onclick = () => this.move(-1);
      el.querySelector('#next').onclick = () => this.move(1);
      el.querySelector('#today').onclick = () => { this.cursor = new Date(); this.cursor.setDate(1); this.load(); };
      el.querySelector('#new').onclick = () => RF.openBooking({ onSaved: () => this.load() });
      await this.load();
    },
    move(n) { this.cursor = new Date(this.cursor.getFullYear(), this.cursor.getMonth() + n, 1); this.load(); },
    range() {
      const first = this.cursor, start = new Date(first);
      start.setDate(1 - ((first.getDay() + 6) % 7));
      const days = Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
      return { days, from: RF.dateStr(days[0]), to: RF.dateStr(days[41]) };
    },
    async load() {
      const { days, from, to } = this.range();
      const room = this.el.querySelector('#room').value;
      this.el.querySelector('#mlabel').textContent = `${MONTHS[this.cursor.getMonth()]} ${this.cursor.getFullYear()}`;
      this.bookings = (await A.getBookings({ from, to, room_id: room })).filter(b => b.status !== 'Cancelled' && b.status !== 'Rejected');
      this.mine = [];
      if (this.el.querySelector('#mine').checked) {
        const r = await A.getMyCalendarEvents({ from, to });
        this.mine = (r.events || []).map(e => ({ ...e, mine: true, room_no: '', room_name: e.location || '', organizer: 'My calendar', status: 'Confirmed', time_state: 'Upcoming' }));
      }
      const byDay = {};
      [...this.bookings, ...this.mine].forEach(b => (byDay[b.start_at.slice(0, 10)] = byDay[b.start_at.slice(0, 10)] || []).push(b));
      const today = RF.today();
      const head = ['MON','TUE','WED','THU','FRI','SAT','SUN'].map(d => `<div class="cal-head">${d}</div>`).join('');
      const cells = days.map(d => {
        const key = RF.dateStr(d), list = byDay[key] || [];
        const other = d.getMonth() !== this.cursor.getMonth();
        const ev = list.slice(0, 3).map((b, i) => `<span class="cal-event ${b.mine ? 'mine' : i % 3 === 1 ? 'green' : i % 3 === 2 ? 'orange' : ''}"><span class="t">${RF.fmtTime(b.start_at)}</span>${RF.esc(b.title)}</span>`).join('');
        const more = list.length > 3 ? `<div class="cal-more">+${list.length - 3} more</div>` : '';
        return `<div class="cal-cell day-cell ${other ? 'other' : ''} ${key === today ? 'today' : ''}" data-day="${key}"><em>${d.getDate()}</em>${ev}${more}</div>`;
      }).join('');
      this.el.querySelector('#grid').innerHTML = head + cells;
      this.el.querySelectorAll('[data-day]').forEach(c => c.onclick = () => this.openDay(c.dataset.day));
    },
    openDay(day) {
      const list = [...this.bookings, ...this.mine].filter(b => b.start_at.startsWith(day)).sort((a, b) => a.start_at < b.start_at ? -1 : 1);
      const rows = list.length ? list.map(b => `<div class="list-row">
          <div class="grow"><strong>${RF.esc(b.title)}</strong><p>${RF.timeRange(b)}${b.mine ? ' · from your calendar' : ` · ${RF.esc(b.room_no)} ${RF.esc(b.room_name)} · ${RF.esc(b.organizer)}`}</p></div>
          ${b.mine ? '<span class="pill purple">My calendar</span>' : RF.statePill(b)}
          ${b.mine ? '' : `<button class="btn small" data-need="bookings.edit_own" data-owner="${b.created_by ?? ''}" data-edit="${b.id}">Edit</button>`}</div>`).join('')
        : '<div class="empty">No bookings on this day.</div>';
      const d = RF.parse(day + ' 00:00:00');
      const m = RF.modal({
        title: d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
        body: `${rows}<div class="modal-actions" style="margin-top:14px"><button class="btn primary" id="add-day" data-need="bookings.create"><i class="fa-solid fa-plus"></i> Book this day</button></div>`,
        onMount: (root, close) => {
          root.querySelector('#add-day').onclick = () => { close(); RF.openBooking({ date: day, onSaved: () => this.load() }); };
          root.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => { close(); RF.openBooking({ booking: list.find(x => x.id == b.dataset.edit), onSaved: () => this.load() }); });
        }
      });
    }
  };
})();
