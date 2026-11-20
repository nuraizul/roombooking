(function () {
  const A = window.RoomFlowAPI, RF = window.RF;
  const TEMPLATES = [['classic', 'Classic'], ['minimal', 'Minimal'], ['bold', 'Bold']];
  RF.pages.settings = {
    events: [],
    async init(el) {
      this.el = el;
      const s = await A.getSettings();
      const allRoles = (await A.getRoles()).roles;
      const teams = await A.getTeams();
      const approvers = allRoles.filter(r => r.perms.includes('bookings.approve')).map(r => r.name);
      const sw = (name, label, desc) => `<div class="toggle-row"><div><strong>${label}</strong><p>${desc}</p></div>
        <input type="checkbox" class="switch" name="${name}" ${s[name] ? 'checked' : ''}></div>`;
      const layoutSel = v => `<select name="default_layout"><option value="landscape" ${v === 'landscape' ? 'selected' : ''}>Landscape (wide screen)</option><option value="portrait" ${v === 'portrait' ? 'selected' : ''}>Portrait (tall screen)</option></select>`;
      const tplSel = v => `<select name="default_template">${TEMPLATES.map(([k, l]) => `<option value="${k}" ${v === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
      el.innerHTML = `
        <section class="panel">
          <div class="panel-head"><div><h2>Microsoft Teams</h2><p>Let people book rooms from Teams. Bookings wait for approval the same way as bookings made in RoomFlow.</p></div></div>
          <div class="toggle-row">
            <div><strong>Microsoft Teams integration: <span id="teams-state">${teams.enabled ? 'ON' : 'OFF'}</span></strong>
              <p>When OFF, the Teams booking endpoint refuses every request.</p></div>
            <input type="checkbox" class="switch" id="teams-enabled" ${teams.enabled ? 'checked' : ''}>
          </div>
          <div class="form-grid" style="margin-top:12px">
            <div class="field full"><label>Teams channel webhook (optional, https)</label>
              <input id="teams-webhook" placeholder="https://prod-xx.westus.logic.azure.com/..." value="${RF.esc(teams.webhook_url)}">
              <p class="muted" style="font-size:11px;margin-top:4px">New requests waiting for approval are posted to this channel. Create it with Power Automate (Workflows) → “Post card in a chat or channel”.</p></div>
          </div>
          <div class="actions" style="margin-top:12px">
            <button class="btn" id="teams-key"><i class="fa-solid fa-key"></i> ${teams.key_set ? 'Generate new key' : 'Generate key'}</button>
            <button class="btn primary" id="teams-save"><i class="fa-solid fa-floppy-disk"></i> Save Teams settings</button>
          </div>
          <div class="toggle-row" style="display:block;margin-top:14px">
            <div><strong>How Teams sends a booking</strong>
              <p>POST <code>${location.origin}${teams.endpoint}</code> with header <code>x-roomflow-key</code> and this JSON. Only these fields are required:</p>
              <pre class="code-box">{ "room": "101", "title": "Project sync", "organizer": "ali@company.com", "start": "2026-11-23T10:00", "end": "2026-11-23T11:00" }</pre>
              <p>Use the room number. The organizer is matched to a RoomFlow user by email or name, which decides whether the booking needs approval.</p></div>
          </div>
        </section>
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
      const tEn = el.querySelector('#teams-enabled');
      tEn.onchange = () => { el.querySelector('#teams-state').textContent = tEn.checked ? 'ON' : 'OFF'; };
      el.querySelector('#teams-save').onclick = async () => {
        const url = el.querySelector('#teams-webhook').value.trim();
        try { await A.saveTeams({ enabled: tEn.checked, webhook_url: url }); RF.toast('Teams settings saved'); }
        catch (e) { RF.toast(e.message, 'error'); }
      };
      el.querySelector('#teams-key').onclick = async () => {
        if (teams.key_set && !RF.confirm('Generate a new key? The old key will stop working.')) return;
        try {
          const { key } = await A.newTeamsKey();
          RF.modal({
            title: 'Your Teams API key',
            body: `<p class="muted" style="font-size:12px;line-height:1.6">Copy this key now and store it in your Power Automate flow as the header <b>x-roomflow-key</b>. It will not be shown again.</p>
              <pre class="code-box" id="key-box">${RF.esc(key)}</pre>
              <div class="modal-actions"><button class="btn" id="copy-key">Copy key</button><button class="btn primary" data-close>Done</button></div>`,
            onMount: root => root.querySelector('#copy-key').onclick = () => { navigator.clipboard?.writeText(key); RF.toast('Key copied'); }
          });
          teams.key_set = true;
        } catch (e) { RF.toast(e.message, 'error'); }
      };
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
