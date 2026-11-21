(function () {
  const A = window.RoomFlowAPI, RF = window.RF;
  const TEMPLATES = [['classic', 'Classic'], ['minimal', 'Minimal'], ['bold', 'Bold']];
  RF.pages.settings = {
    events: [],
    async init(el) {
      this.el = el;
      const s = await A.getSettings();
      const allRoles = (await A.getRoles()).roles;
      const approvers = allRoles.filter(r => r.perms.includes('bookings.approve')).map(r => r.name);
      const sw = (name, label, desc) => `<div class="toggle-row"><div><strong>${label}</strong><p>${desc}</p></div>
        <input type="checkbox" class="switch" name="${name}" ${s[name] ? 'checked' : ''}></div>`;
      const layoutSel = v => `<select name="default_layout"><option value="landscape" ${v === 'landscape' ? 'selected' : ''}>Landscape (wide screen)</option><option value="portrait" ${v === 'portrait' ? 'selected' : ''}>Portrait (tall screen)</option></select>`;
      const designs = await A.getDesigns();
      const tplSel = v => `<select name="default_template">${TEMPLATES.map(([k, l]) => `<option value="${k}" ${v === k ? 'selected' : ''}>${l}</option>`).join('')}${designs.map(d => `<option value="design:${d.id}" ${v === 'design:' + d.id ? 'selected' : ''}>Custom: ${RF.esc(d.name)}</option>`).join('')}</select>`;
      el.innerHTML = `
        <form id="sf" novalidate>
          <section class="panel">
            <div class="panel-head"><div><h2>Display defaults</h2><p>Used by every room display unless a tablet has its own choice in Room Displays</p></div></div>
            <div class="form-grid">
              <div class="field"><label>Default layout</label>${layoutSel(s.default_layout)}</div>
              <div class="field"><label>Default design</label>${tplSel(s.default_template)}</div>
            </div>
            <p class="muted" style="font-size:12px;margin-top:10px;line-height:1.6">
              <b>Classic</b>: the dark look with a coloured status card.<br>
              <b>Minimal</b>: light background, plain card, large text. Good for bright rooms.<br>
              <b>Bold</b>: the whole screen turns green when the room is free and orange when in use. Easy to read from the door.</p>
          </section>
          <section class="panel">
            <div class="panel-head"><div><h2>General</h2><p>Shown in the header and on displays</p></div></div>
            <div class="form-grid">
              <div class="field"><label>System name</label><input name="system_name" maxlength="100" value="${RF.esc(s.system_name)}"></div>
              <div class="field"><label>Organization</label><input name="organization" maxlength="100" value="${RF.esc(s.organization)}"></div>
              <div class="field"><label>Time format</label><select name="time_format"><option value="12" ${s.time_format === '12' ? 'selected' : ''}>12-hour (AM/PM)</option><option value="24" ${s.time_format === '24' ? 'selected' : ''}>24-hour</option></select></div>
              <div class="field"><label>Display refresh (seconds)</label><input type="number" name="display_refresh_seconds" min="5" max="3600" value="${s.display_refresh_seconds}"></div>
            </div>
          </section>
          <section class="panel">
            <div class="panel-head"><div><h2>Booking rules</h2><p>Applied to every new and edited booking</p></div></div>
            <div class="form-grid">
              <div class="field"><label>Default meeting duration (minutes)</label><input type="number" name="default_duration" min="5" max="720" value="${s.default_duration}"></div>
              <div class="field"><label>Buffer between meetings (minutes)</label><input type="number" name="buffer_minutes" min="0" max="120" value="${s.buffer_minutes}"></div>
            </div>
            <div style="margin-top:10px">
              ${sw('allow_same_day', 'Allow same-day bookings', 'When off, users must book from tomorrow onward.')}

            </div>
          </section>
          <section class="panel">
            <div class="panel-head"><div><h2>Approve pending booking</h2><p>Some bookings wait for an approver before they are confirmed</p></div></div>
            <div class="toggle-row">
              <div><strong>Approve pending booking: ${s.require_approval ? 'ON' : 'OFF'}</strong>
                <p>When ON, bookings made by people whose role cannot approve wait as <i>Pending</i>. Pending bookings hold the room until approved. When OFF, every booking is confirmed straight away.</p></div>
              <input type="checkbox" class="switch" name="require_approval" ${s.require_approval ? 'checked' : ''}>
            </div>
            <div class="toggle-row" style="display:block">
              <div><strong>Who can approve</strong>
                <p>Set on the Roles page: tick <i>Approve pending bookings</i> on a role. Roles that have it are the approvers and their bookings do not wait.</p></div>
              <p style="margin-top:10px;font-size:12px">Current approvers: <b>${approvers.map(RF.esc).join(', ') || 'none (turn this off, or add the permission to a role)'}</b></p>
            </div>
          </section>
          <div class="form-error" id="serr"></div>
          <div class="actions" style="margin-top:6px"><button class="btn primary" type="submit"><i class="fa-solid fa-floppy-disk"></i> Save settings</button></div>
        </form>`;
      el.querySelector('#sf').onsubmit = async e => {
        e.preventDefault();
        const f = e.target, v = RF.readForm(f);
        const payload = {
          system_name: v.system_name, organization: v.organization, time_format: v.time_format,
          default_layout: v.default_layout, default_template: v.default_template,
          display_refresh_seconds: Number(v.display_refresh_seconds), default_duration: Number(v.default_duration),
          buffer_minutes: Number(v.buffer_minutes), allow_same_day: !!v.allow_same_day,
          require_approval: !!v.require_approval
        };
        try {
          RF.settings = await A.saveSettings(payload);
          el.querySelector('#serr').textContent = '';
          RF.toast('Settings saved');
        } catch (ex) { el.querySelector('#serr').textContent = ex.message; }
      };
    }
  };
})();
