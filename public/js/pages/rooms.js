(function () {
  const A = window.RoomFlowAPI, RF = window.RF;
  RF.pages.rooms = {
    events: ['rooms:changed', 'bookings:changed'],
    rooms: [],
    async init(el) {
      this.el = el;
      el.innerHTML = `
        <div class="stats" id="stats"></div>
        <section class="panel">
          <div class="panel-head"><div><h2>Room inventory</h2><p>Room list, capacity and facilities</p></div>
            <button class="btn primary" id="add"><i class="fa-solid fa-plus"></i> Add room</button></div>
          <div class="toolbar">
            <div class="search"><i class="fa-solid fa-magnifying-glass"></i><input id="q" placeholder="Search room name or number"></div>
            <select id="floor"><option value="">All floors</option></select>
          </div>
          <div class="room-grid" id="grid"></div>
        </section>`;
      el.querySelector('#add').onclick = () => this.form();
      el.querySelector('#q').oninput = () => this.render();
      el.querySelector('#floor').onchange = () => this.render();
      await this.load();
    },
    async load() {
      const rooms = await A.getRoomStatus();
      this.rooms = rooms;
      const floors = [...new Set(rooms.map(r => r.floor).filter(Boolean))].sort();
      const sel = this.el.querySelector('#floor'), cur = sel.value;
      sel.innerHTML = '<option value="">All floors</option>' + floors.map(f => `<option ${f === cur ? 'selected' : ''}>${RF.esc(f)}</option>`).join('');
      const occ = rooms.filter(r => r.status === 'Occupied').length;
      const cap = rooms.reduce((n, r) => n + r.capacity, 0);
      this.el.querySelector('#stats').innerHTML = [
        ['Rooms', rooms.length, 'Active rooms', 'fa-door-open', ''],
        ['Available now', rooms.length - occ, 'Not in use', 'fa-circle-check', 'green'],
        ['Occupied now', occ, 'In use', 'fa-users', 'orange'],
        ['Total seats', cap, 'Combined capacity', 'fa-chair', '']
      ].map(([t, v, f, i, k]) => `<div class="stat"><div class="stat-row"><span>${t}</span><span class="stat-icon ${k}"><i class="fa-solid ${i}"></i></span></div><h2>${v}</h2><small>${f}</small></div>`).join('');
      this.render();
    },
    render() {
      const q = this.el.querySelector('#q').value.toLowerCase(), floor = this.el.querySelector('#floor').value;
      const list = this.rooms.filter(r => (!floor || r.floor === floor) &&
        (!q || `${r.name} ${r.room_no}`.toLowerCase().includes(q)));
      this.el.querySelector('#grid').innerHTML = list.length
        ? list.map(r => RF.roomCard(r, `<button class="btn small" data-edit="${r.id}"><i class="fa-solid fa-pen"></i> Edit</button>
            <button class="btn small danger" data-off="${r.id}"><i class="fa-solid fa-ban"></i> Deactivate</button>`)).join('')
        : '<div class="empty">No rooms match your filter.</div>';
      this.el.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => this.form(this.rooms.find(r => r.id == b.dataset.edit)));
      this.el.querySelectorAll('[data-off]').forEach(b => b.onclick = () => this.deactivate(this.rooms.find(r => r.id == b.dataset.off)));
    },
    async deactivate(room) {
      if (!RF.confirm(`Deactivate ${room.name}? It will be hidden from booking.`)) return;
      try { await A.setRoomActive(room.id, false); RF.toast('Room deactivated'); this.load(); }
      catch (e) { RF.toast(e.message, 'error'); }
    },
    form(room = null) {
      RF.modal({
        title: room ? 'Edit room' : 'Add room',
        body: `<form class="form-grid" id="rf" novalidate>
          <div class="field"><label>Room number</label><input name="room_no" maxlength="20" required value="${RF.esc(room?.room_no || '')}"></div>
          <div class="field"><label>Capacity</label><input name="capacity" type="number" min="0" value="${room?.capacity ?? 8}"></div>
          <div class="field full"><label>Room name</label><input name="name" maxlength="100" required value="${RF.esc(room?.name || '')}"></div>
          <div class="field"><label>Floor</label><input name="floor" maxlength="40" value="${RF.esc(room?.floor || '')}" placeholder="Level 1"></div>
          <div class="field full"><label>Facilities</label><div>${RF.facilityChecks(room?.facilities || [])}</div></div>
          <div class="field full"><div class="form-error" id="rerr"></div></div>
          <div class="field full modal-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">${room ? 'Save room' : 'Add room'}</button></div>
        </form>`,
        onMount: (root, close) => {
          const f = root.querySelector('#rf');
          f.onsubmit = async e => {
            e.preventDefault();
            const v = RF.readForm(f);
            const payload = { room_no: v.room_no, name: v.name, floor: v.floor, capacity: Number(v.capacity || 0), facilities: v.facilities || [] };
            try {
              if (room) await A.updateRoom(room.id, payload); else await A.addRoom(payload);
              RF.toast(room ? 'Room updated' : 'Room added'); close(); this.load();
            } catch (ex) { root.querySelector('#rerr').textContent = ex.message; }
          };
        }
      });
    }
  };
})();
