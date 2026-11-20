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
          <section class="panel">
            <div class="panel-head"><div><h2>Email booking</h2><p>People book a room by emailing or cc'ing the booking mailbox. Bookings arrive as Pending for a Receptionist to approve.</p></div></div>
            <div class="toggle-row">
              <div><strong>Accept bookings by email: ${s.inbound_enabled ? 'ON' : 'OFF'}</strong>
                <p>When OFF, every email is refused. Turn it on only after Power Automate is set up.</p></div>
              <input type="checkbox" class="switch" name="inbound_enabled" ${s.inbound_enabled ? 'checked' : ''}>
            </div>
            <div class="form-grid" style="margin-top:12px">
              <div class="field"><label>Working hours from</label><input type="time" name="inbound_open" value="${RF.esc(s.inbound_open)}"></div>
              <div class="field"><label>Working hours to</label><input type="time" name="inbound_close" value="${RF.esc(s.inbound_close)}"></div>
            </div>
            <div class="field full" style="margin-top:12px"><label>Endpoint for Power Automate</label>
              <div class="copy-row"><input id="ib-url" readonly value="${RF.esc(location.origin)}/api/inbound/email"><button type="button" class="btn small" id="ib-copy-url">Copy</button></div></div>
            <div class="field full" style="margin-top:12px"><label>Secret (sent in header <code>X-Inbound-Secret</code>)</label>
              <div class="copy-row"><input id="ib-secret" readonly value="${RF.esc(s.inbound_secret || 'Not generated yet. Turn the feature on and save.')}">
                <button type="button" class="btn small" id="ib-copy-secret">Copy</button>
                <button type="button" class="btn small danger" id="ib-regen">Regenerate</button></div>
              <p class="muted" style="font-size:11px;margin-top:6px">Regenerate only if the secret leaks. Every Power Automate flow must then be updated with the new one.</p></div>
            <p class="muted" style="font-size:12px;margin-top:14px;line-height:1.7">
              Book: <code>[BOOK] Bilik 101 | 25/11/2026 | 14:00-15:00 | Tajuk mesyuarat</code><br>
              Cancel: <code>[CANCEL] Bilik 101 | 25/11/2026 | 14:00-15:00</code></p>
            <h3 style="margin-top:14px;font-size:13px">Recent emails</h3>
            <div id="ib-log" style="margin-top:6px"></div>
          </section>
          <div class="form-error" id="serr"></div>
          <div class="actions" style="margin-top:6px"><button class="btn primary" type="submit"><i class="fa-solid fa-floppy-disk"></i> Save settings</button></div>
        </form>`;
      const copy = (id) => { navigator.clipboard?.writeText(el.querySelector(id).value).then(() => RF.toast('Copied')).catch(() => RF.toast('Select the text and copy it', 'error')); };
      el.querySelector('#ib-copy-url').onclick = () => copy('#ib-url');
      el.querySelector('#ib-copy-secret').onclick = () => copy('#ib-secret');
      el.querySelector('#ib-regen').onclick = async () => {
        if (!RF.confirm('Generate a new secret? Power Automate will stop working until you update it.')) return;
        try { const r = await A.regenerateInboundSecret(); el.querySelector('#ib-secret').value = r.inbound_secret; RF.toast('New secret generated'); }
        catch (ex) { RF.toast(ex.message, 'error'); }
      };
      const loadLog = async () => {
        const rows = await A.getInboundLog();
        const label = { created: 'Pending approval', cancelled: 'Cancelled', conflict: 'Clash', invalid: 'Invalid', rejected: 'Refused', forbidden: 'Not allowed', not_found: 'Not found', outside_hours: 'Outside hours' };
        el.querySelector('#ib-log').innerHTML = rows.length
          ? `<table><thead><tr><th>When</th><th>From</th><th>Result</th><th>Message</th></tr></thead><tbody>${rows.map(r => `<tr><td>${RF.esc(r.received_at.slice(5, 16))}</td><td>${RF.esc(r.sender || '-')}</td><td><span class="table-status ${r.outcome === 'created' || r.outcome === 'cancelled' ? '' : 'inactive'}">${RF.esc(label[r.outcome] || r.outcome)}</span></td><td class="muted">${RF.esc(r.message || '')}</td></tr>`).join('')}</tbody></table>`
          : '<div class="empty">No emails yet.</div>';
      };
      loadLog().catch(() => {});
      el.querySelector('#sf').onsubmit = async e => {
        e.preventDefault();
        const f = e.target, v = RF.readForm(f);
        const payload = {
          system_name: v.system_name, organization: v.organization, time_format: v.time_format,
          default_layout: v.default_layout, default_template: v.default_template,
          display_refresh_seconds: Number(v.display_refresh_seconds), default_duration: Number(v.default_duration),
          buffer_minutes: Number(v.buffer_minutes), allow_same_day: !!v.allow_same_day,
          require_approval: !!v.require_approval,
          inbound_enabled: !!v.inbound_enabled, inbound_open: v.inbound_open, inbound_close: v.inbound_close
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
