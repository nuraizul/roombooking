(function () {
  const A = window.RoomFlowAPI, RF = window.RF;
  const W = 1000, H = 600;   // canvas units (match the server)
  RF.pages.floorplan = {
    events: ['bookings:changed', 'rooms:changed'],
    data: null, level: null, selected: null, dirty: new Set(),

    async init(el) {
      this.el = el;
      el.innerHTML = `
        <section class="panel">
          <div class="panel-head">
            <div><h2 id="lvl-title">Floor plan</h2><p id="lvl-sub">Drag rooms into place. Colours show live status.</p></div>
            <div class="actions">
              <button class="btn" id="lvl-new" data-need="rooms.manage"><i class="fa-solid fa-plus"></i> New level</button>
              <button class="btn" id="lvl-rename" data-need="rooms.manage"><i class="fa-solid fa-pen"></i> Rename</button>
              <button class="btn danger" id="lvl-del" data-need="rooms.manage"><i class="fa-solid fa-trash"></i> Delete level</button>
              <button class="btn primary" id="save" data-need="rooms.manage" disabled><i class="fa-solid fa-floppy-disk"></i> Save layout</button>
            </div>
          </div>
          <div class="level-tabs" id="tabs"></div>
          <div class="fp-wrap">
            <div class="fp-canvas" id="canvas"></div>
            <aside class="fp-side" id="side"></aside>
          </div>
          <div class="fp-legend"><span><i class="dot-free"></i> Available</span><span><i class="dot-busy"></i> In use</span><span><i class="dot-off"></i> Not on this level</span></div>
        </section>`;
      el.querySelector('#lvl-new')?.addEventListener('click', () => this.newLevel());
      el.querySelector('#lvl-rename')?.addEventListener('click', () => this.renameLevel());
      el.querySelector('#lvl-del')?.addEventListener('click', () => this.deleteLevel());
      el.querySelector('#save')?.addEventListener('click', () => this.save());
      await this.load();
    },

    async load() {
      if (this.dirty.size) return;   // keep unsaved edits; the next refresh picks up server changes
      this.data = await A.getFloorplan();
      if (!this.level || !this.data.levels.includes(this.level)) this.level = this.data.levels[0] || null;
      this.render();
    },

    roomsOnLevel() { return this.data.rooms.filter(r => r.floor === this.level); },
    room(id) { return this.data.rooms.find(r => r.id === id); },

    render() {
      const el = this.el;
      el.querySelector('#lvl-title').textContent = this.level ? `Floor plan · ${this.level}` : 'Floor plan';
      el.querySelector('#tabs').innerHTML = this.data.levels.length
        ? this.data.levels.map(l => `<button class="level-tab ${l === this.level ? 'active' : ''}" data-level="${RF.esc(l)}">${RF.esc(l)}</button>`).join('')
        : '<span class="muted">No levels yet. Click “New level” to start.</span>';
      el.querySelectorAll('[data-level]').forEach(b => b.onclick = () => this.switchLevel(b.dataset.level));
      const saveBtn = el.querySelector('#save');
      if (saveBtn) saveBtn.disabled = this.dirty.size === 0;
      this.renderCanvas();
      this.renderSide();
    },

    switchLevel(name) {
      if (this.dirty.size && !RF.confirm('You have unsaved changes on this level. Leave without saving?')) return;
      this.dirty.clear();
      this.level = name; this.selected = null;
      this.render();
    },

    renderCanvas() {
      const cv = this.el.querySelector('#canvas');
      if (!this.level) { cv.innerHTML = '<div class="empty">Create a level first.</div>'; return; }
      const placed = this.roomsOnLevel().filter(r => r.x !== null && r.x !== undefined);
      cv.innerHTML = placed.map(r => {
        const busy = r.status === 'Occupied';
        return `<div class="fp-room ${busy ? 'busy' : 'free'} ${this.selected === r.id ? 'sel' : ''}" data-id="${r.id}"
          style="left:${r.x / W * 100}%;top:${r.y / H * 100}%;width:${r.w / W * 100}%;height:${r.h / H * 100}%">
          <b>${RF.esc(r.room_no)}</b><span>${RF.esc(r.name)}</span>
          <em>${busy ? 'In use' : 'Free'}</em>
        </div>`;
      }).join('') || '<div class="fp-empty">No rooms placed on this level yet. Add rooms from the list on the right.</div>';
      if (RF.can('rooms.manage')) this.bindDrag(cv);
      cv.querySelectorAll('.fp-room').forEach(b => b.onclick = e => {
        if (b.dataset.moved === '1') { b.dataset.moved = ''; return; }
        this.selected = Number(b.dataset.id); this.render();
      });
    },

    bindDrag(cv) {
      cv.querySelectorAll('.fp-room').forEach(block => {
        block.onpointerdown = e => {
          const r = this.room(Number(block.dataset.id));
          const rect = cv.getBoundingClientRect();
          const toUnits = ev => ({ x: (ev.clientX - rect.left) / rect.width * W, y: (ev.clientY - rect.top) / rect.height * H });
          const start = toUnits(e), ox = r.x - start.x, oy = r.y - start.y;
          let moved = false;
          block.setPointerCapture(e.pointerId);
          const move = ev => {
            const p = toUnits(ev);
            const nx = Math.max(0, Math.min(W - r.w, p.x + ox)), ny = Math.max(0, Math.min(H - r.h, p.y + oy));
            if (Math.abs(nx - r.x) + Math.abs(ny - r.y) > 2) moved = true;
            r.x = Math.round(nx); r.y = Math.round(ny);
            block.style.left = `${r.x / W * 100}%`; block.style.top = `${r.y / H * 100}%`;
          };
          const up = () => {
            block.removeEventListener('pointermove', move);
            block.removeEventListener('pointerup', up);
            if (moved) { this.dirty.add(r.id); block.dataset.moved = '1'; this.render(); }
          };
          block.addEventListener('pointermove', move);
          block.addEventListener('pointerup', up);
        };
      });
    },

    renderSide() {
      const side = this.el.querySelector('#side');
      const manage = RF.can('rooms.manage');
      const r = this.selected ? this.room(this.selected) : null;
      let html = '';
      if (r) {
        const cur = r.current ? `${RF.fmtTime(r.current.start_at)} – ${RF.fmtTime(r.current.end_at)} · ${RF.esc(r.current.title)}` : 'Free now';
        const nxt = r.next ? `${RF.fmtTime(r.next.start_at)} · ${RF.esc(r.next.title)}` : 'None scheduled';
        html += `<div class="fp-card">
          <h3>${RF.esc(r.name)}</h3><p class="muted">Room ${RF.esc(r.room_no)} · ${r.capacity} seats</p>
          <p><b>Now:</b> ${cur}</p><p><b>Next:</b> ${nxt}</p>
          <div class="chiprow">${(r.facilities || []).map(f => `<span class="chip">${RF.esc(f)}</span>`).join('')}</div>`;
        if (manage) {
          const levelOpts = this.data.levels.map(l => `<option ${l === r.floor ? 'selected' : ''}>${RF.esc(l)}</option>`).join('');
          html += `<div class="fp-form">
            <label>Level</label><select id="f-level">${levelOpts}</select>
            <div class="fp-grid4">
              <div><label>X</label><input type="number" id="f-x" value="${r.x ?? 0}" min="0" max="${W - 40}"></div>
              <div><label>Y</label><input type="number" id="f-y" value="${r.y ?? 0}" min="0" max="${H - 40}"></div>
              <div><label>Width</label><input type="number" id="f-w" value="${r.w ?? 160}" min="40" max="${W}"></div>
              <div><label>Height</label><input type="number" id="f-h" value="${r.h ?? 100}" min="40" max="${H}"></div>
            </div>
            <button class="btn small" id="f-remove" ${r.x == null ? 'disabled' : ''}>Remove from this level</button>
          </div>`;
        }
        html += '</div>';
      } else {
        html += `<div class="fp-card"><p class="muted">Click a room on the plan to see its status${manage ? ' and edit its position' : ''}.</p></div>`;
      }
      const unplaced = this.data.rooms.filter(x => x.x === null || x.x === undefined);
      if (manage) {
        html += `<div class="fp-card"><h3>Not placed yet</h3>
          ${unplaced.length ? unplaced.map(x => `<div class="fp-unplaced"><span><b>${RF.esc(x.room_no)}</b> ${RF.esc(x.name)}<small>${x.floor ? RF.esc(x.floor) : 'no level'}</small></span>
            <button class="btn small" data-add="${x.id}" ${this.level ? '' : 'disabled'}>Add here</button></div>`).join('') : '<p class="muted">All rooms are placed.</p>'}
        </div>`;
      }
      side.innerHTML = html;
      if (manage && r) this.bindForm(r);
      side.querySelectorAll('[data-add]').forEach(b => b.onclick = () => this.addToLevel(Number(b.dataset.add)));
    },

    bindForm(r) {
      const set = (key, v) => { r[key] = v; this.dirty.add(r.id); };
      const num = (id, key, min, max) => {
        this.el.querySelector(id).onchange = e => {
          const n = Math.round(Number(e.target.value));
          if (!Number.isFinite(n)) return;
          set(key, Math.max(min, Math.min(max, n)));
          this.render();
        };
      };
      num('#f-x', 'x', 0, W - 40); num('#f-y', 'y', 0, H - 40);
      num('#f-w', 'w', 40, W); num('#f-h', 'h', 40, H);
      this.el.querySelector('#f-level').onchange = e => { r.floor = e.target.value; this.dirty.add(r.id); this.render(); };
      this.el.querySelector('#f-remove').onclick = () => { r.x = r.y = r.w = r.h = null; this.selected = null; this.dirty.add(r.id); this.render(); };
    },

    addToLevel(id) {
      const r = this.room(id);
      r.floor = this.level; r.w = 160; r.h = 100; r.x = 40 + (this.roomsOnLevel().length % 5) * 30; r.y = 40 + (this.roomsOnLevel().length % 5) * 30;
      this.dirty.add(id); this.selected = id; this.render();
    },

    async save() {
      const rooms = [...this.dirty].map(id => this.room(id)).map(r => ({
        id: r.id, floor: r.floor || '',
        x: r.x ?? null, y: r.y ?? null, w: r.w ?? null, h: r.h ?? null
      }));
      try {
        await A.saveFloorplan(rooms);
        this.dirty.clear();
        RF.toast('Layout saved');
        await this.load();
      } catch (e) { RF.toast(e.message, 'error'); }
    },

    newLevel() {
      const name = window.prompt('Name of the new level (for example: Level 3):', '');
      if (!name || !name.trim()) return;
      A.addLevel(name.trim()).then(() => { this.level = name.trim(); RF.toast('Level added'); this.load(); })
        .catch(e => RF.toast(e.message, 'error'));
    },
    renameLevel() {
      if (!this.level) return;
      const name = window.prompt('New name for this level:', this.level);
      if (!name || !name.trim() || name.trim() === this.level) return;
      A.renameLevel(this.level, name.trim()).then(() => { this.level = name.trim(); RF.toast('Level renamed'); this.load(); })
        .catch(e => RF.toast(e.message, 'error'));
    },
    async deleteLevel() {
      if (!this.level) return;
      if (!RF.confirm(`Delete level "${this.level}"? It must have no rooms on it.`)) return;
      try { await A.deleteLevel(this.level); this.level = null; RF.toast('Level deleted'); this.load(); }
      catch (e) { RF.toast(e.message, 'error'); }
    }
  };
})();
