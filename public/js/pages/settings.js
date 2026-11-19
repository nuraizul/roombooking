(function () {
  const A = window.RoomFlowAPI, RF = window.RF;
  RF.pages.settings = {
    events: [],
    async init(el) {
      this.el = el;
      const s = await A.getSettings();
      const sw = (name, label, desc) => `<div class="toggle-row"><div><strong>${label}</strong><p>${desc}</p></div>
        <input type="checkbox" class="switch" name="${name}" ${s[name] ? 'checked' : ''}></div>`;
      el.innerHTML = `
        <form id="sf" novalidate>
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
              ${sw('require_approval', 'Require approval', 'New bookings start as Pending until an admin approves them. Pending slots still block the room.')}
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
          display_refresh_seconds: Number(v.display_refresh_seconds), default_duration: Number(v.default_duration),
          buffer_minutes: Number(v.buffer_minutes), allow_same_day: !!v.allow_same_day, require_approval: !!v.require_approval
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
