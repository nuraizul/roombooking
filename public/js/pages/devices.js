(function () {
  const A = window.RoomFlowAPI, RF = window.RF;
  RF.pages.display = {
    events: ['devices:changed', 'rooms:changed'],
    devices: [], rooms: [], settings: {}, designs: [],
    async init(el) {
      this.el = el;
      el.innerHTML = `
        <div class="stats" id="stats"></div>
        <section class="panel">
          <div class="panel-head"><div><h2>Display devices</h2><p>Each tablet shows one room. Assign a room below; changes apply live.</p></div>
            <button class="btn primary" id="reg"><i class="fa-solid fa-plus"></i> Register device</button></div>
          <div class="device-grid" id="devs"></div>
        </section>
        <section class="panel">
          <div class="panel-head"><div><h2>Setup</h2><p>Open this address on each Android tablet (same network as this server).</p></div></div>
          <p class="muted" style="font-size:12px;line-height:1.6">Full-screen display URL: <code>http://&lt;server-ip&gt;:3000/display.html?code=DISPLAY-101</code>.
          Replace <code>DISPLAY-101</code> with the device code you registered. Use the tablet’s browser in full-screen or kiosk mode.</p>
        </section>`;
      el.querySelector('#reg').onclick = () => this.form();
      await this.load();
    },
    async load() {
      const [devices, rooms, settings, designs] = await Promise.all([A.getDevices(), A.getRooms(), A.getSettings(), A.getDesigns()]);
      this.designs = designs;
      this.devices = devices; this.rooms = rooms; this.settings = settings;
      const L = { landscape: 'Landscape', portrait: 'Portrait' };
      const T = { classic: 'Classic', minimal: 'Minimal', bold: 'Bold' };
      this.designs.forEach(d => { T['design:' + d.id] = 'Custom: ' + d.name; });
      const layoutOpts = v => `<option value="">Default (${L[this.settings.default_layout]})</option>` + Object.entries(L).map(([k, l]) => `<option value="${k}" ${v === k ? 'selected' : ''}>${l}</option>`).join('');
      const tplOpts = v => `<option value="">Default (${T[this.settings.default_template] || 'Classic'})</option>` + Object.entries(T).map(([k, l]) => `<option value="${k}" ${v === k ? 'selected' : ''}>${l}</option>`).join('');
      const online = devices.filter(d => d.online).length;
      this.el.querySelector('#stats').innerHTML = [
        ['Total devices', devices.length, 'Registered displays', 'fa-display', ''],
        ['Online', online, 'Seen in last 2 min', 'fa-wifi', 'green'],
        ['Offline', devices.length - online, 'Needs attention', 'fa-plug', 'red'],
        ['Unassigned', devices.filter(d => !d.room_id).length, 'Not linked to a room', 'fa-link', 'orange']
      ].map(([t, v, f, i, k]) => `<div class="stat"><div class="stat-row"><span>${t}</span><span class="stat-icon ${k}"><i class="fa-solid ${i}"></i></span></div><h2>${v}</h2><small>${f}</small></div>`).join('');
      const opts = sel => '<option value="">— Not assigned —</option>' + rooms.map(r => `<option value="${r.id}" ${r.id == sel ? 'selected' : ''}>${RF.esc(r.room_no)} · ${RF.esc(r.name)}</option>`).join('');
      this.el.querySelector('#devs').innerHTML = devices.length ? devices.map(d => `
        <div class="device-card">
          <div class="device-symbol"><i class="fa-solid fa-tablet-screen-button"></i></div>
          <div style="min-width:0">
            <h3>${RF.esc(d.device_name)}</h3>
            <p>${RF.esc(d.device_code)} · ${RF.esc(d.platform)}</p>
            <div class="meta">${d.last_seen ? 'Last seen ' + RF.fmtTime(d.last_seen) + ' ' + RF.fmtDate(d.last_seen) : 'Never connected'}</div>
          </div>
          <div class="dev-actions">
            <select data-assign="${d.id}" title="Room">${opts(d.room_id)}</select>
            <select data-layout="${d.id}" title="Layout">${layoutOpts(d.layout)}</select>
            <select data-tpl="${d.id}" title="Design">${tplOpts(d.template)}</select>
            <span class="pill ${d.online ? 'green' : 'gray'}">${d.online ? 'Online' : 'Offline'}</span>
            <a class="btn small" href="display.html?code=${encodeURIComponent(d.device_code)}" target="_blank"><i class="fa-solid fa-up-right-from-square"></i></a>
            <button class="btn small danger" data-del="${d.id}"><i class="fa-solid fa-trash"></i></button>
          </div>
        </div>`).join('') : '<div class="empty">No devices registered yet.</div>';
      this.el.querySelectorAll('[data-assign]').forEach(s => s.onchange = async () => {
        try { await A.assignDevice(s.dataset.assign, s.value || null); RF.toast('Device assigned'); this.load(); }
        catch (e) { RF.toast(e.message, 'error'); }
      });
      const saveDisplay = async id => {
        const lay = this.el.querySelector(`[data-layout="${id}"]`).value || null;
        const tpl = this.el.querySelector(`[data-tpl="${id}"]`).value || null;
        try { await A.setDeviceDisplay(id, { layout: lay, template: tpl }); RF.toast('Display updated'); this.load(); }
        catch (e) { RF.toast(e.message, 'error'); }
      };
      this.el.querySelectorAll('[data-layout]').forEach(s => s.onchange = () => saveDisplay(s.dataset.layout));
      this.el.querySelectorAll('[data-tpl]').forEach(s => s.onchange = () => saveDisplay(s.dataset.tpl));
      this.el.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
        if (!RF.confirm('Remove this device registration?')) return;
        try { await A.deleteDevice(b.dataset.del); RF.toast('Device removed'); this.load(); }
        catch (e) { RF.toast(e.message, 'error'); }
      });
    },
    form() {
      RF.modal({
        title: 'Register display device',
        body: `<form class="form-grid" id="df" novalidate>
          <div class="field"><label>Device code</label><input name="device_code" maxlength="40" required placeholder="DISPLAY-101"></div>
          <div class="field"><label>Platform</label><select name="platform"><option>Android</option><option>iOS</option><option>Browser</option></select></div>
          <div class="field full"><label>Device name</label><input name="device_name" maxlength="60" required placeholder="Room 101 tablet"></div>
          <div class="field full"><label>Assign to room</label><select name="room_id"><option value="">— Not assigned —</option>${this.rooms.map(r => `<option value="${r.id}">${RF.esc(r.room_no)} · ${RF.esc(r.name)}</option>`).join('')}</select></div>
          <div class="field full"><div class="form-error" id="derr"></div></div>
          <div class="field full modal-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Register</button></div>
        </form>`,
        onMount: (root, close) => {
          const f = root.querySelector('#df');
          f.onsubmit = async e => {
            e.preventDefault();
            const v = RF.readForm(f);
            try {
              await A.registerDevice({ device_code: v.device_code, device_name: v.device_name, platform: v.platform, room_id: v.room_id || null });
              RF.toast('Device registered'); close(); this.load();
            } catch (ex) { root.querySelector('#derr').textContent = ex.message; }
          };
        }
      });
    }
  };
})();
