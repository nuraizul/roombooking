(function () {
  const A = window.RoomFlowAPI, RF = window.RF;
  RF.pages.roles = {
    events: ['roles:changed', 'users:changed'],
    roles: [], catalog: [],
    async init(el) {
      this.el = el;
      el.innerHTML = `
        <div class="stats" id="stats"></div>
        <section class="panel">
          <div class="panel-head"><div><h2>Roles</h2><p>Each user gets one role. The role decides which pages and buttons they can use.</p></div>
            <button class="btn primary" id="add" data-need="roles.manage"><i class="fa-solid fa-plus"></i> New role</button></div>
          <div class="room-grid" id="grid"></div>
        </section>`;
      el.querySelector('#add').onclick = () => this.form();
      await this.load();
    },
    async load() {
      const data = await A.getRoles();
      this.roles = data.roles; this.catalog = data.catalog;
      const users = this.roles.reduce((n, r) => n + r.user_count, 0);
      this.el.querySelector('#stats').innerHTML = [
        ['Roles', this.roles.length, 'Built-in and custom', 'fa-user-tag', ''],
        ['Custom roles', this.roles.filter(r => !r.system).length, 'Created by admins', 'fa-pen-ruler', 'orange'],
        ['Permissions', this.catalog.length, 'Available to choose from', 'fa-key', 'green'],
        ['Users assigned', users, 'Across all roles', 'fa-users', '']
      ].map(([t, v, f, i, k]) => `<div class="stat"><div class="stat-row"><span>${t}</span><span class="stat-icon ${k}"><i class="fa-solid ${i}"></i></span></div><h2>${v}</h2><small>${f}</small></div>`).join('');
      this.el.querySelector('#grid').innerHTML = this.roles.map(r => {
        const groups = [...new Set(r.perms.map(k => (this.catalog.find(c => c.key === k) || {}).group).filter(Boolean))];
        return `<article class="room-card">
          <div class="room-top"><span class="badge ${r.system ? '' : 'busy'}">${r.system ? '<i class="dot"></i>Built-in' : '<i class="dot"></i>Custom'}</span></div>
          <h3>${RF.esc(r.name)}</h3>
          <div class="room-meta"><span><i class="fa-solid fa-key"></i>${r.system ? 'All permissions' : r.perms.length + ' permissions'}</span><span><i class="fa-solid fa-users"></i>${r.user_count} user(s)</span></div>
          <div class="chiprow">${groups.map(g => `<span class="chip">${RF.esc(g)}</span>`).join('') || '<span class="chip">No access</span>'}</div>
          <div class="card-actions">
            <button class="btn small" data-need="roles.manage" data-view="${RF.esc(r.name)}"><i class="fa-solid fa-${r.system ? 'eye' : 'pen'}"></i> ${r.system ? 'View' : 'Edit'}</button>
            ${r.system ? '' : `<button class="btn small danger" data-need="roles.manage" data-del="${RF.esc(r.name)}"><i class="fa-solid fa-trash"></i> Delete</button>`}
          </div></article>`;
      }).join('');
      this.el.querySelectorAll('[data-view]').forEach(b => b.onclick = () => this.form(this.roles.find(r => r.name === b.dataset.view)));
      this.el.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
        if (!RF.confirm(`Delete role "${b.dataset.del}"?`)) return;
        try { await A.deleteRole(b.dataset.del); RF.toast('Role deleted'); this.load(); }
        catch (e) { RF.toast(e.message, 'error'); }
      });
    },
    form(role = null) {
      const locked = role?.system;
      const groups = [...new Set(this.catalog.map(c => c.group))];
      const boxes = groups.map(g => `<div class="perm-group"><h4>${RF.esc(g)}</h4>${this.catalog.filter(c => c.group === g).map(c =>
        `<label class="perm"><input type="checkbox" name="perms[]" value="${c.key}" ${(locked || role?.perms.includes(c.key)) ? 'checked' : ''} ${locked ? 'disabled' : ''}> ${RF.esc(c.label)}</label>`).join('')}</div>`).join('');
      RF.modal({
        title: locked ? 'Administrator (built-in)' : role ? 'Edit role' : 'New role',
        width: 640,
        body: `<form id="rf" novalidate>
          <div class="field"><label>Role name</label><input name="name" maxlength="40" required value="${RF.esc(role?.name || '')}" ${locked ? 'disabled' : ''} placeholder="e.g. Front Desk"></div>
          ${locked ? '<p class="muted" style="font-size:12px;margin:10px 0">The Administrator role always has every permission, so at least one admin can always manage the system.</p>' : '<p class="muted" style="font-size:12px;margin:10px 0">Tick what users with this role are allowed to do.</p>'}
          <div class="perm-grid">${boxes}</div>
          <div class="form-error" id="rerr"></div>
          <div class="modal-actions">
            <button type="button" class="btn" data-close>${locked ? 'Close' : 'Cancel'}</button>
            ${locked ? '' : '<button class="btn primary">Save role</button>'}
          </div>
        </form>`,
        onMount: (root, close) => {
          const f = root.querySelector('#rf');
          f.onsubmit = async e => {
            e.preventDefault();
            const v = RF.readForm(f);
            try {
              if (role) await A.updateRole(role.name, { name: v.name, perms: v.perms || [] });
              else await A.addRole({ name: v.name, perms: v.perms || [] });
              RF.toast('Role saved'); close(); this.load();
            } catch (ex) { root.querySelector('#rerr').textContent = ex.message; }
          };
        }
      });
    }
  };
})();
