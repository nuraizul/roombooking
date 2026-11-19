(function () {
  const A = window.RoomFlowAPI, RF = window.RF;
  RF.pages.users = {
    events: ['users:changed'],
    users: [],
    async init(el) {
      this.el = el;
      el.innerHTML = `
        <div class="stats" id="stats"></div>
        <section class="panel">
          <div class="panel-head"><div><h2>Users</h2><p>Accounts, roles and access</p></div>
            <button class="btn primary" id="add"><i class="fa-solid fa-plus"></i> Add user</button></div>
          <div class="toolbar">
            <div class="search"><i class="fa-solid fa-magnifying-glass"></i><input id="q" placeholder="Search name or email"></div>
            <select id="role"><option value="">All roles</option><option>Administrator</option><option>Staff</option></select>
          </div>
          <div class="table-wrap" id="table"></div>
        </section>`;
      el.querySelector('#add').onclick = () => this.form();
      el.querySelector('#q').oninput = () => this.render();
      el.querySelector('#role').onchange = () => this.render();
      await this.load();
    },
    async load() { this.users = await A.getUsers(); this.stats(); this.render(); },
    stats() {
      const u = this.users, admins = u.filter(x => x.role === 'Administrator').length, active = u.filter(x => x.active).length;
      this.el.querySelector('#stats').innerHTML = [
        ['Total users', u.length, 'Registered accounts', 'fa-users', ''],
        ['Administrators', admins, 'Admin access', 'fa-user-shield', 'orange'],
        ['Active', active, 'Enabled accounts', 'fa-user-check', 'green'],
        ['Inactive', u.length - active, 'Disabled accounts', 'fa-user-slash', 'red']
      ].map(([t, v, f, i, k]) => `<div class="stat"><div class="stat-row"><span>${t}</span><span class="stat-icon ${k}"><i class="fa-solid ${i}"></i></span></div><h2>${v}</h2><small>${f}</small></div>`).join('');
    },
    render() {
      const q = this.el.querySelector('#q').value.toLowerCase(), role = this.el.querySelector('#role').value;
      const list = this.users.filter(u => (!role || u.role === role) && (!q || `${u.name} ${u.email}`.toLowerCase().includes(q)));
      const rows = list.map(u => `<tr>
        <td><strong>${RF.esc(u.name)}</strong></td><td>${RF.esc(u.email)}</td><td>${RF.esc(u.role)}</td>
        <td><span class="table-status ${u.active ? '' : 'inactive'}">${u.active ? 'Active' : 'Inactive'}</span></td>
        <td><div class="table-actions">
          <button class="btn small" data-edit="${u.id}">Edit</button>
          <button class="btn small" data-toggle="${u.id}">${u.active ? 'Disable' : 'Enable'}</button></div></td></tr>`).join('');
      this.el.querySelector('#table').innerHTML = list.length
        ? `<table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
        : '<div class="empty">No users yet. Click “Add user”.</div>';
      this.el.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => this.form(this.users.find(u => u.id == b.dataset.edit)));
      this.el.querySelectorAll('[data-toggle]').forEach(b => b.onclick = async () => {
        const u = this.users.find(x => x.id == b.dataset.toggle);
        try { await A.setUserActive(u.id, !u.active); RF.toast(u.active ? 'User disabled' : 'User enabled'); this.load(); }
        catch (e) { RF.toast(e.message, 'error'); }
      });
    },
    form(user = null) {
      RF.modal({
        title: user ? 'Edit user' : 'Add user',
        body: `<form class="form-grid" id="uf" novalidate>
          <div class="field full"><label>Full name</label><input name="name" maxlength="80" required value="${RF.esc(user?.name || '')}"></div>
          <div class="field full"><label>Email</label><input name="email" type="email" maxlength="120" required value="${RF.esc(user?.email || '')}"></div>
          <div class="field full"><label>Role</label><select name="role"><option ${user?.role !== 'Administrator' ? 'selected' : ''}>Staff</option><option ${user?.role === 'Administrator' ? 'selected' : ''}>Administrator</option></select></div>
          <div class="field full"><div class="form-error" id="uerr"></div></div>
          <div class="field full modal-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">${user ? 'Save user' : 'Add user'}</button></div>
        </form>`,
        onMount: (root, close) => {
          const f = root.querySelector('#uf');
          f.onsubmit = async e => {
            e.preventDefault();
            const v = RF.readForm(f);
            try {
              if (user) await A.updateUser(user.id, v); else await A.addUser(v);
              RF.toast(user ? 'User updated' : 'User added'); close(); this.load();
            } catch (ex) { root.querySelector('#uerr').textContent = ex.message; }
          };
        }
      });
    }
  };
})();
