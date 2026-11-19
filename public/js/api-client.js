// Browser API helper. Every page talks to Express; Express talks to SQLite.
(function () {
  const BASE = '/api';

  async function request(path, { method = 'GET', body } = {}) {
    const res = await fetch(BASE + path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    let data = {};
    try { data = await res.json(); } catch (_) { /* empty body */ }
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  const qs = obj => {
    const p = new URLSearchParams();
    Object.entries(obj || {}).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') p.set(k, v); });
    const s = p.toString();
    return s ? '?' + s : '';
  };

  window.RoomFlowAPI = {
    request,
    health: () => request('/health'),

    getSettings: () => request('/settings'),
    saveSettings: s => request('/settings', { method: 'PUT', body: s }),

    getRooms: () => request('/rooms'),
    getRoomStatus: () => request('/rooms/status'),
    addRoom: r => request('/rooms', { method: 'POST', body: r }),
    updateRoom: (id, r) => request(`/rooms/${id}`, { method: 'PUT', body: r }),
    setRoomActive: (id, active) => request(`/rooms/${id}/active`, { method: 'PATCH', body: { active } }),

    getBookings: f => request('/bookings' + qs(f)),
    createBooking: b => request('/bookings', { method: 'POST', body: b }),
    updateBooking: (id, b) => request(`/bookings/${id}`, { method: 'PUT', body: b }),
    cancelBooking: id => request(`/bookings/${id}/cancel`, { method: 'PATCH' }),
    approveBooking: id => request(`/bookings/${id}/approve`, { method: 'PATCH' }),

    getDevices: () => request('/devices'),
    registerDevice: d => request('/devices/register', { method: 'POST', body: d }),
    assignDevice: (id, room_id) => request(`/devices/${id}/assign`, { method: 'PATCH', body: { room_id } }),
    deleteDevice: id => request(`/devices/${id}`, { method: 'DELETE' }),
    getDisplay: code => request(`/display/${encodeURIComponent(code)}`),

    getUsers: () => request('/users'),
    addUser: u => request('/users', { method: 'POST', body: u }),
    updateUser: (id, u) => request(`/users/${id}`, { method: 'PUT', body: u }),
    setUserActive: (id, active) => request(`/users/${id}/active`, { method: 'PATCH', body: { active } })
  };
})();
