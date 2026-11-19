(function () {
  const A = window.RoomFlowAPI, RF = window.RF;
  RF.pages.dashboard = {
    events: ['bookings:changed', 'rooms:changed'],
    async init(el) { this.el = el; el.innerHTML = `
      <div class="stats" id="stats"></div>
      <section class="panel">
        <div class="panel-head"><div><h2>Room overview</h2><p>Live status of every active room</p></div>
          <div class="actions"><button class="btn primary" id="new-b" data-need="bookings.create"><i class="fa-solid fa-plus"></i> New booking</button></div></div>
        <div class="room-grid" id="rooms"></div>
      </section>
      <section class="panel">
        <div class="panel-head"><div><h2>Today’s bookings</h2><p id="today-label"></p></div><a class="btn" href="bookings.html">View all <i class="fa-solid fa-arrow-right"></i></a></div>
        <div id="today"></div>
      </section>`;
      el.querySelector('#new-b').onclick = () => RF.openBooking({ onSaved: () => this.load() });
      await this.load();
    },
    async load() {
      const el = this.el, today = RF.today();
      const [rooms, bookings] = await Promise.all([A.getRoomStatus(), A.getBookings({ from: today, to: today })]);
      const occupied = rooms.filter(r => r.status === 'Occupied').length;
      const active = bookings.filter(b => b.status !== 'Cancelled' && b.status !== 'Rejected');
      const pending = (await A.getBookings({ from: today, to: RF.dateStr(new Date(Date.now() + 30 * 864e5)) })).filter(b => b.status === 'Pending').length;
      el.querySelector('#stats').innerHTML = [
        ['Total rooms', rooms.length, 'Active rooms', 'fa-door-open', ''],
        ['Available now', rooms.length - occupied, 'Ready to book', 'fa-circle-check', 'green'],
        ['Occupied now', occupied, 'In use right now', 'fa-users', 'orange'],
        ['Pending approval', pending, 'Next 30 days', 'fa-hourglass-half', 'red']
      ].map(([t, v, f, i, k]) => `<div class="stat"><div class="stat-row"><span>${t}</span><span class="stat-icon ${k}"><i class="fa-solid ${i}"></i></span></div><h2>${v}</h2><small>${f}</small></div>`).join('');
      el.querySelector('#rooms').innerHTML = rooms.length ? rooms.map(r => RF.roomCard(r)).join('') : '<div class="empty">No rooms yet. Add rooms on the Rooms page.</div>';
      el.querySelector('#today-label').textContent = `${RF.fmtDate(today + ' 00:00:00')} · ${active.length} active booking(s)`;
      el.querySelector('#today').innerHTML = active.length ? active.map(b => `
        <div class="booking-row">
          <div class="time">${RF.fmtTime(b.start_at)}<small>${RF.fmtTime(b.end_at)}</small></div>
          <div class="booking-bar ${b.time_state === 'Ongoing' ? 'green' : b.time_state === 'Completed' ? 'purple' : ''}"></div>
          <div class="booking-details"><strong>${RF.esc(b.title)}</strong><p><i class="fa-solid fa-door-open"></i> ${RF.esc(b.room_no)} · ${RF.esc(b.room_name)} · ${RF.esc(b.organizer)}</p></div>
          ${RF.statePill(b)}
        </div>`).join('') : '<div class="empty">No bookings today.</div>';
    }
  };
})();
