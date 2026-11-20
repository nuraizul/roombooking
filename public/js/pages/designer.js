(function () {
  const A = window.RoomFlowAPI, RF = window.RF;

  const WIDGETS = {
    text:       { label: 'Text', icon: 'fa-font', w: 40, h: 12, props: { content: 'Welcome', size: 96, color: '#ffffff', bold: true, align: 'left', valign: 'flex-start' } },
    image:      { label: 'Photo', icon: 'fa-image', w: 30, h: 40, props: { url: '', fit: 'cover', radius: 16 } },
    video:      { label: 'Video', icon: 'fa-film', w: 40, h: 40, props: { url: '', fit: 'cover' } },
    clock:      { label: 'Clock & date', icon: 'fa-clock', w: 30, h: 18, props: { format: 'both', size: 110, color: '#ffffff' } },
    room_name:  { label: 'Room name', icon: 'fa-door-open', w: 50, h: 14, props: { size: 96, color: '#ffffff', showNumber: true } },
    status:     { label: 'Status (Available / In use)', icon: 'fa-circle-check', w: 40, h: 20, props: { freeText: 'AVAILABLE', busyText: 'IN USE', freeColor: '#2f9e6b', busyColor: '#e0892a', size: 120 } },
    current:    { label: 'Current meeting', icon: 'fa-calendar-day', w: 50, h: 20, props: { freeText: 'Room is free', size: 60, color: '#ffffff' } },
    next:       { label: 'Next meeting', icon: 'fa-forward', w: 50, h: 16, props: { label: 'Next:', emptyText: 'No more meetings today', size: 52, color: '#ffffff' } },
    schedule:   { label: "Today's schedule", icon: 'fa-list', w: 40, h: 40, props: { count: 5, size: 40, color: '#ffffff' } },
    facilities: { label: 'Facilities', icon: 'fa-plug', w: 40, h: 8, props: { size: 36, color: '#ffffff' } },
    shape:      { label: 'Box', icon: 'fa-square', w: 30, h: 20, props: { fill: '#22324c', radius: 24, opacity: 1 } }
  };
  // property editors per element type: [key, label, kind]
  const SCHEMA = {
    text: [['content', 'Text', 'textarea'], ['size', 'Font size', 'number'], ['color', 'Colour', 'color'], ['bold', 'Bold', 'bool'], ['align', 'Align', 'select:left,center,right'], ['valign', 'Vertical', 'select:flex-start,center,flex-end']],
    image: [['url', 'Photo', 'image'], ['fit', 'Fit', 'select:cover,contain'], ['radius', 'Corner radius', 'number']],
    video: [['url', 'Video', 'video'], ['fit', 'Fit', 'select:cover,contain']],
    clock: [['format', 'Show', 'select:both,time,date'], ['size', 'Font size', 'number'], ['color', 'Colour', 'color']],
    room_name: [['showNumber', 'Show room number', 'bool'], ['size', 'Font size', 'number'], ['color', 'Colour', 'color']],
    status: [['freeText', 'Text when free', 'text'], ['busyText', 'Text when in use', 'text'], ['freeColor', 'Colour when free', 'color'], ['busyColor', 'Colour when in use', 'color'], ['size', 'Font size', 'number']],
    current: [['freeText', 'Text when free', 'text'], ['size', 'Font size', 'number'], ['color', 'Colour', 'color']],
    next: [['label', 'Label (leave empty to hide)', 'text'], ['emptyText', 'Text when no more meetings', 'text'], ['size', 'Font size', 'number'], ['color', 'Colour', 'color']],
    schedule: [['count', 'How many meetings', 'number'], ['size', 'Font size', 'number'], ['color', 'Colour', 'color']],
    facilities: [['size', 'Font size', 'number'], ['color', 'Colour', 'color']],
    shape: [['fill', 'Fill colour', 'color'], ['radius', 'Corner radius', 'number'], ['opacity', 'Opacity (0 to 1)', 'number']]
  };
  const uid = () => Math.random().toString(36).slice(2, 10);
  const PRESETS = [
    ['1920x1080', 'Full HD landscape (1920 × 1080)'], ['1280x800', 'Tablet landscape 10" (1280 × 800)'],
    ['1280x720', 'HD landscape (1280 × 720)'], ['1024x768', 'iPad landscape (1024 × 768)'],
    ['1080x1920', 'Full HD portrait (1080 × 1920)'], ['800x1280', 'Tablet portrait 10" (800 × 1280)'],
    ['768x1024', 'iPad portrait (768 × 1024)'], ['custom', 'Custom size…']
  ];
  const pad = n => String(n).padStart(2, '0');

  RF.pages.designer = {
    events: ['devices:changed'],
    mode: 'list', d: null, sel: null, previewBusy: false,

    async init(el) { this.el = el; await this.showList(); },
    async load() { if (this.mode === 'list') await this.showList(); },

    // ---------- list of designs
    async showList() {
      this.mode = 'list';
      const list = await A.getDesigns();
      this.list = list;
      this.el.innerHTML = `
        <section class="panel">
          <div class="panel-head"><div><h2>Your display designs</h2><p>Create a screen for a tablet, then choose it in Room Displays.</p></div>
            <button class="btn primary" id="new" data-need="designs.manage"><i class="fa-solid fa-plus"></i> New design</button></div>
          <div class="dz-cards" id="cards"></div>
        </section>`;
      this.el.querySelector('#new')?.addEventListener('click', () => this.openEditor(null));
      const cards = this.el.querySelector('#cards');
      cards.innerHTML = list.length ? list.map(d => `
        <div class="dz-card">
          <div class="dz-thumb" id="thumb-${d.id}" style="aspect-ratio:${d.width || 1920} / ${d.height || 1080}"></div>
          <div><strong>${RF.esc(d.name)}</strong><div class="muted" style="font-size:11px">${d.width || 1920} × ${d.height || 1080} · updated ${RF.esc((d.updated_at || '').slice(0, 16))}</div></div>
          <div class="card-actions" style="margin-top:0;border:0;padding:0">
            <button class="btn small" data-need="designs.manage" data-edit="${d.id}"><i class="fa-solid fa-pen"></i> Edit</button>
            <button class="btn small danger" data-need="designs.manage" data-del="${d.id}"><i class="fa-solid fa-trash"></i> Delete</button>
          </div>
        </div>`).join('') : '<div class="empty">No designs yet. Click “New design” to make your first screen.</div>';
      // thumbnails use the same renderer as the tablet
      for (const d of list) {
        const full = await A.request(`/designs/${d.id}`);
        const box = cards.querySelector(`#thumb-${d.id}`);
        if (box) RFDesign.mount(box, full, this.sample(false), {});
      }
      cards.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => this.openEditor(Number(b.dataset.edit)));
      cards.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
        const d = this.list.find(x => x.id == b.dataset.del);
        if (!RF.confirm(`Delete design "${d.name}"?`)) return;
        try { await A.request(`/designs/${d.id}`, { method: 'DELETE' }); RF.toast('Design deleted'); this.showList(); }
        catch (e) { RF.toast(e.message, 'error'); }
      });
    },

    // ---------- editor
    async openEditor(id) {
      this.mode = 'edit';
      this.d = id ? await A.request(`/designs/${id}`) : { name: 'New design', width: 1920, height: 1080, bg: '#0e1522', elements: [] };
      if (!this.d.width) { this.d.width = this.d.orientation === 'portrait' ? 1080 : 1920; this.d.height = this.d.orientation === 'portrait' ? 1920 : 1080; }
      this.sel = null;
      this.el.innerHTML = `
        <section class="panel">
          <div class="panel-head"><div><h2>${id ? 'Edit design' : 'New design'}</h2><p>Drag elements onto the screen. Pick when each one shows in its properties.</p></div>
            <div class="actions"><button class="btn" id="back"><i class="fa-solid fa-arrow-left"></i> Back</button><button class="btn primary" id="save"><i class="fa-solid fa-floppy-disk"></i> Save design</button></div></div>
          <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin-bottom:14px">
            <div style="min-width:220px;flex:1"><label class="muted" style="font-size:11px">Design name</label><input id="dname" value="${RF.esc(this.d.name)}" maxlength="60" style="width:100%;height:34px;border:1px solid var(--border);border-radius:8px;padding:0 10px"></div>
            <div><label class="muted" style="font-size:11px">Screen resolution</label>
              <div style="display:flex;gap:6px;align-items:center"><select id="dres" style="height:34px;border:1px solid var(--border);border-radius:8px;padding:0 8px;max-width:240px">${PRESETS.map(([v, l]) => `<option value="${v}" ${v === this.resKey() ? 'selected' : ''}>${l}</option>`).join('')}</select>
              <input id="dw" type="number" min="320" max="3840" value="${this.d.width}" style="width:84px;height:34px;border:1px solid var(--border);border-radius:8px;padding:0 8px" title="Width (px)">
              <span class="muted">×</span>
              <input id="dh" type="number" min="320" max="3840" value="${this.d.height}" style="width:84px;height:34px;border:1px solid var(--border);border-radius:8px;padding:0 8px" title="Height (px)"></div></div>
            <div><label class="muted" style="font-size:11px">Background</label><input type="color" id="dbg" value="${this.d.bg}" style="width:60px;height:34px;border:1px solid var(--border);border-radius:8px;padding:2px"></div>
            <div><label class="muted" style="font-size:11px">Preview</label><select id="dpreview" style="height:34px;border:1px solid var(--border);border-radius:8px;padding:0 8px"><option value="free">Room available</option><option value="busy">Room in use</option></select></div>
          </div>
          <div class="dz-editor">
            <div class="dz-palette">${Object.entries(WIDGETS).map(([k, w]) => `<button class="btn" data-add="${k}"><i class="fa-solid ${w.icon}"></i> ${w.label}</button>`).join('')}</div>
            <div><div class="dz-canvas-wrap ${this.d.orientation === 'portrait' ? 'portrait' : ''}" id="cv"></div>
              <p class="muted" style="font-size:11px;margin-top:8px">Drag to move. Drag the blue corner to resize. Click an element to edit it. Changes show here as you make them.</p></div>
            <div class="dz-props" id="props"></div>
          </div>
        </section>`;
      this.bindEditor();
      this.refresh();
    },

    sample(busy) {
      const day = RF.today(), at = (h, m) => `${day} ${pad(h)}:${pad(m)}:00`;
      return {
        room: { name: 'Meeting Room Alpha', room_no: '101', floor: 'Level 1', capacity: 8, facilities: ['Display', 'Wi-Fi', 'Video'] },
        current: busy ? { title: 'Project sync', organizer: 'Nuraizul', start_at: at(10, 0), end_at: at(11, 0) } : null,
        next: { title: 'Client review', organizer: 'Ali', start_at: at(14, 0), end_at: at(15, 0) },
        live: [
          { title: 'Project sync', organizer: 'Nuraizul', start_at: at(10, 0), end_at: at(11, 0) },
          { title: 'Client review', organizer: 'Ali', start_at: at(14, 0), end_at: at(15, 0) },
          { title: 'Budget call', organizer: 'Siti', start_at: at(16, 0), end_at: at(17, 0) }
        ],
        settings: { time_format: RF.settings.time_format || '12' }, now: new Date(), offsetMs: 0
      };
    },

    bindEditor() {
      const el = this.el;
      el.querySelector('#back').onclick = () => { if (RF.confirm('Leave without saving?')) this.showList(); };
      el.querySelector('#save').onclick = () => this.save();
      el.querySelector('#dname').oninput = e => { this.d.name = e.target.value; };
      el.querySelector('#dres').onchange = e => {
        if (e.target.value === 'custom') { this.refresh(); return; }
        const [w, h] = e.target.value.split('x').map(Number);
        this.setRes(w, h);
      };
      const custom = () => {
        const w = Math.round(Number(el.querySelector('#dw').value)), h = Math.round(Number(el.querySelector('#dh').value));
        if (w >= 320 && h >= 320 && w <= 3840 && h <= 3840) this.setRes(w, h, true);
      };
      el.querySelector('#dw').oninput = custom;
      el.querySelector('#dh').oninput = custom;
      el.querySelector('#dbg').oninput = e => { this.d.bg = e.target.value; this.refresh(); };
      el.querySelector('#dpreview').onchange = e => { this.previewBusy = e.target.value === 'busy'; this.refresh(); };
      el.querySelectorAll('[data-add]').forEach(b => b.onclick = () => this.add(b.dataset.add));
    },

    resKey() {
      const k = `${this.d.width}x${this.d.height}`;
      return PRESETS.some(([v]) => v === k) ? k : 'custom';
    },
    setRes(w, h, fromInput) {
      this.d.width = w; this.d.height = h;
      this.d.orientation = h >= w ? 'portrait' : 'landscape';
      if (!fromInput) { this.el.querySelector('#dw').value = w; this.el.querySelector('#dh').value = h; }
      this.refresh();
    },

    add(type) {
      const def = WIDGETS[type];
      const e = { id: uid(), type, x: 10, y: 10, w: def.w, h: def.h, show: 'always', props: JSON.parse(JSON.stringify(def.props)) };
      this.d.elements.push(e);
      this.sel = e.id;
      this.refresh();
    },

    // full refresh: selection, add, delete, resolution changes
    refresh() {
      this.refreshCanvas();
      this.renderProps();
    },
    // canvas only: used while typing, so the properties panel keeps its focus
    refreshCanvas() {
      const cv = this.el.querySelector('#cv');
      const r = RFDesign.resolutionOf(this.d);
      cv.style.aspectRatio = `${r.w} / ${r.h}`;
      // tall screens: keep the whole screen visible without scrolling
      cv.style.maxWidth = r.h > r.w ? `calc(74vh * ${r.w} / ${r.h})` : '';
      cv.style.margin = r.h > r.w ? '0 auto' : '';
      RFDesign.mount(cv, this.d, this.sample(this.previewBusy), { editable: true, selected: this.sel });
      this.bindCanvas(cv);
    },

    bindCanvas(cv) {
      cv.onpointerdown = e => { if (e.target === cv || e.target.classList.contains('dz-stage')) { this.sel = null; this.refresh(); } };
      cv.querySelectorAll('.dz-el').forEach(node => {
        const e = this.d.elements.find(x => x.id === node.dataset.eid);
        node.onpointerdown = ev => {
          if (ev.target.classList.contains('dz-handle')) return;
          ev.preventDefault();
          this.sel = e.id;
          this.drag(ev, cv, e, node, false);
        };
        const h = node.querySelector('.dz-handle');
        if (h) h.onpointerdown = ev => { ev.preventDefault(); ev.stopPropagation(); this.sel = e.id; this.drag(ev, cv, e, node, true); };
      });
    },

    drag(ev, cv, e, node, resize) {
      const stage = cv.querySelector('.dz-stage').getBoundingClientRect();
      const sx = ev.clientX, sy = ev.clientY, ox = e.x, oy = e.y, ow = e.w, oh = e.h;
      let moved = false;
      node.setPointerCapture(ev.pointerId);
      const move = m => {
        const dx = (m.clientX - sx) / stage.width * 100, dy = (m.clientY - sy) / stage.height * 100;
        if (Math.abs(dx) + Math.abs(dy) > 0.2) moved = true;
        if (resize) {
          e.w = Math.round(Math.max(2, Math.min(100 - e.x, ow + dx)) * 10) / 10;
          e.h = Math.round(Math.max(2, Math.min(100 - e.y, oh + dy)) * 10) / 10;
        } else {
          e.x = Math.round(Math.max(0, Math.min(100 - e.w, ox + dx)) * 10) / 10;
          e.y = Math.round(Math.max(0, Math.min(100 - e.h, oy + dy)) * 10) / 10;
        }
        node.style.left = e.x + '%'; node.style.top = e.y + '%'; node.style.width = e.w + '%'; node.style.height = e.h + '%';
      };
      const up = () => {
        node.removeEventListener('pointermove', move);
        node.removeEventListener('pointerup', up);
        if (moved) this.refresh(); else this.refresh();
      };
      node.addEventListener('pointermove', move);
      node.addEventListener('pointerup', up);
    },

    renderProps() {
      const box = this.el.querySelector('#props');
      const e = this.d.elements.find(x => x.id === this.sel);
      if (!e) { box.innerHTML = '<p class="muted" style="font-size:12px">Click an element on the screen to edit it, or add one from the left.</p>'; return; }
      const w = WIDGETS[e.type];
      const schema = SCHEMA[e.type] || [];
      const field = (key, label, kind, value) => {
        const id = `p-${key}`;
        if (kind === 'textarea') return `<div><label>${label}</label><textarea data-p="${key}" data-k="${kind}">${RF.esc(value ?? '')}</textarea></div>`;
        if (kind === 'bool') return `<label style="display:flex;gap:8px;align-items:center;margin:0"><input type="checkbox" data-p="${key}" data-k="bool" ${value ? 'checked' : ''} style="width:auto"> ${label}</label>`;
        if (kind === 'color') return `<div><label>${label}</label><input type="color" data-p="${key}" data-k="color" value="${value || '#ffffff'}" style="height:34px;padding:2px"></div>`;
        if (kind === 'number') return `<div><label>${label}</label><input type="number" step="any" data-p="${key}" data-k="number" value="${value ?? ''}"></div>`;
        if (kind.startsWith('select:')) return `<div><label>${label}</label><select data-p="${key}" data-k="text">${kind.slice(7).split(',').map(o => `<option ${o === value ? 'selected' : ''}>${o}</option>`).join('')}</select></div>`;
        if (kind === 'video') return `<div><label>${label}</label>
          <input type="text" data-p="${key}" data-k="text" value="${RF.esc(value || '')}" placeholder="YouTube link, or upload below">
          <input type="file" accept="video/mp4,video/webm,video/ogg" id="vupload" style="margin-top:6px"><div class="muted" style="font-size:10px">Upload an MP4 / WebM file up to 60 MB, or paste a YouTube link.</div></div>`;
        if (kind === 'image') return `<div><label>${label}</label>
          <input type="text" data-p="${key}" data-k="text" value="${RF.esc(value || '')}" placeholder="https://… or upload below">
          <input type="file" accept="image/*" id="upload" style="margin-top:6px"><div class="muted" style="font-size:10px">Upload up to 1.5 MB, or paste a web link.</div></div>`;
        return `<div><label>${label}</label><input type="text" data-p="${key}" data-k="text" value="${RF.esc(value ?? '')}"></div>`;
      };
      box.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center"><strong>${RF.esc(w.label)}</strong>
          <button class="btn small danger" id="del-el"><i class="fa-solid fa-trash"></i> Remove</button></div>
        <div class="row2"><div><label>X (%)</label><input type="number" step="0.5" data-e="x" value="${e.x}"></div><div><label>Y (%)</label><input type="number" step="0.5" data-e="y" value="${e.y}"></div></div>
        <div class="row2"><div><label>Width (%)</label><input type="number" step="0.5" data-e="w" value="${e.w}"></div><div><label>Height (%)</label><input type="number" step="0.5" data-e="h" value="${e.h}"></div></div>
        <div><label>Show this element</label><select data-e="show"><option value="always" ${e.show === 'always' ? 'selected' : ''}>Always</option><option value="free" ${e.show === 'free' ? 'selected' : ''}>Only when room is available</option><option value="busy" ${e.show === 'busy' ? 'selected' : ''}>Only when room is in use</option></select></div>
        <hr style="border:0;border-top:1px solid var(--border);margin:4px 0">
        ${schema.map(([k, l, kind]) => field(k, l, kind, e.props[k] ?? w.props[k])).join('')}`;
      box.querySelectorAll('[data-e]').forEach(inp => inp.oninput = () => {
        const key = inp.dataset.e;
        e[key] = key === 'show' ? inp.value : Number(inp.value);
        this.refreshCanvas();
      });
      box.querySelectorAll('[data-p]').forEach(inp => inp.oninput = inp.onchange = () => {
        const key = inp.dataset.p, kind = inp.dataset.k;
        e.props[key] = kind === 'bool' ? inp.checked : kind === 'number' ? Number(inp.value) : inp.value;
        this.refreshCanvas();
      });
      const vup = box.querySelector('#vupload');
      if (vup) vup.onchange = async () => {
        const f = vup.files[0]; if (!f) return;
        if (f.size > 60 * 1024 * 1024) { RF.toast('Video is bigger than 60 MB.', 'error'); return; }
        RF.toast('Uploading video…');
        try {
          const res = await fetch('/api/uploads', { method: 'POST', headers: { 'Content-Type': f.type }, body: f, credentials: 'same-origin' });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'Upload failed');
          e.props.url = data.url; RF.toast('Video uploaded'); this.refresh();
        } catch (ex) { RF.toast(ex.message, 'error'); }
      };
      const up = box.querySelector('#upload');
      if (up) up.onchange = () => {
        const f = up.files[0]; if (!f) return;
        if (f.size > 1.5 * 1024 * 1024) { RF.toast('Photo is bigger than 1.5 MB. Use a smaller file or a web link.', 'error'); return; }
        const reader = new FileReader();
        reader.onload = () => { e.props.url = reader.result; this.refresh(); RF.toast('Photo added'); };
        reader.readAsDataURL(f);
      };
      box.querySelector('#del-el').onclick = () => { this.d.elements = this.d.elements.filter(x => x.id !== e.id); this.sel = null; this.refresh(); };
    },

    async save() {
      const name = this.el.querySelector('#dname').value.trim();
      const payload = { name, width: this.d.width, height: this.d.height, bg: this.d.bg, elements: this.d.elements };
      try {
        if (this.d.id) await A.request(`/designs/${this.d.id}`, { method: 'PUT', body: payload });
        else await A.request('/designs', { method: 'POST', body: payload });
        RF.toast('Design saved');
        this.showList();
      } catch (e) { RF.toast(e.message, 'error'); }
    }
  };
})();
