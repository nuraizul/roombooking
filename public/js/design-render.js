// Renders a custom display design. Used by the tablet display AND the designer preview,
// so what you see in the designer is what the tablet shows.
(function () {
  const BASE = { landscape: { w: 1920, h: 1080 }, portrait: { w: 1080, h: 1920 } };
  const pad = n => String(n).padStart(2, '0');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const parse = s => new Date(String(s).replace(' ', 'T'));
  const hm = (s, fmt) => { const d = parse(s); return fmt === '24' ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }); };
  const youtubeId = u => { const m = String(u || '').match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{6,})/); return m ? m[1] : null; };

  function clockText(format, now, fmt) {
    const t = fmt === '24' ? `${pad(now.getHours())}:${pad(now.getMinutes())}` : now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    const d = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    return { time: t, date: d, format };
  }

  function elementHtml(e, ctx, editing) {
    const p = e.props || {};
    const box = `left:${e.x}%;top:${e.y}%;width:${e.w}%;height:${e.h}%`;
    const wrap = (inner, extra = '') => `<div class="dz-el${editing && ctx.selected === e.id ? ' dz-sel' : ''}" data-eid="${esc(e.id)}" style="${box};${extra}">${inner}${editing ? '<span class="dz-handle"></span>' : ''}</div>`;
    const size = p.size || 48, color = p.color || '#ffffff';
    switch (e.type) {
      case 'text':
        return wrap(`<div style="width:100%;font-size:${size}px;color:${color};font-weight:${p.bold ? 700 : 400};text-align:${p.align || 'left'};white-space:pre-wrap;line-height:1.15">${esc(p.content || '')}</div>`, `display:flex;align-items:${p.valign || 'flex-start'};`);
      case 'image': {
        const src = p.url || '';
        return wrap(src ? `<img src="${esc(src)}" alt="" style="width:100%;height:100%;object-fit:${p.fit || 'cover'};border-radius:${p.radius || 0}px;pointer-events:none">`
          : `<div class="dz-placeholder">Photo: add an image in properties</div>`);
      }
      case 'video': {
        const yt = youtubeId(p.url);
        if (yt) return wrap(`<iframe src="https://www.youtube.com/embed/${yt}?autoplay=1&mute=1&loop=1&playlist=${yt}&controls=0&playsinline=1" allow="autoplay; encrypted-media" style="width:100%;height:100%;border:0;pointer-events:none"></iframe>`);
        if (/^https?:\/\/.+\.(mp4|webm|ogg)(\?|$)/i.test(p.url || '')) return wrap(`<video src="${esc(p.url)}" muted autoplay loop playsinline style="width:100%;height:100%;object-fit:${p.fit || 'cover'};pointer-events:none"></video>`);
        return wrap(`<div class="dz-placeholder">Video: paste a YouTube link or an MP4 link in properties</div>`);
      }
      case 'clock': {
        const c = clockText(p.format || 'both', ctx.now, ctx.fmt);
        const timeHtml = `<div class="dz-clock-time" style="font-size:${size}px;color:${color};font-weight:700;line-height:1">${c.time}</div>`;
        const dateHtml = `<div class="dz-clock-date" style="font-size:${Math.round(size * 0.3)}px;color:${color};opacity:.8;margin-top:.2em">${c.date}</div>`;
        const inner = p.format === 'time' ? timeHtml : p.format === 'date' ? `<div class="dz-clock-date" style="font-size:${size}px;color:${color};font-weight:700">${c.date}</div>` : timeHtml + dateHtml;
        return wrap(inner, `display:flex;flex-direction:column;justify-content:center;`);
      }
      case 'room_name': {
        const r = ctx.room || {};
        const label = p.showNumber ? `${r.room_no ? 'ROOM ' + r.room_no + ' · ' : ''}${r.name || ''}` : (r.name || '');
        return wrap(`<div style="font-size:${size}px;color:${color};font-weight:700;line-height:1.05">${esc(label)}</div>`, 'display:flex;align-items:center;');
      }
      case 'status': {
        const busy = !!ctx.current;
        return wrap(`<div style="font-size:${size}px;font-weight:800;letter-spacing:1px;color:${busy ? (p.busyColor || '#e0892a') : (p.freeColor || '#2f9e6b')}">${esc(busy ? (p.busyText || 'IN USE') : (p.freeText || 'AVAILABLE'))}</div>`, 'display:flex;align-items:center;justify-content:center;text-align:center;');
      }
      case 'current': {
        const c = ctx.current;
        const inner = c
          ? `<div style="font-size:${size}px;color:${color};font-weight:700;line-height:1.1">${esc(c.title)}</div><div style="font-size:${Math.round(size * .55)}px;color:${color};opacity:.85;margin-top:.3em">${esc(c.organizer)} · ${hm(c.start_at, ctx.fmt)} – ${hm(c.end_at, ctx.fmt)}</div>`
          : `<div style="font-size:${size}px;color:${color};font-weight:600">${esc(p.freeText || 'Room is free')}</div>`;
        return wrap(inner, 'display:flex;flex-direction:column;justify-content:center;');
      }
      case 'next': {
        const n = ctx.next;
        const label = p.label === undefined ? 'Next:' : p.label;
        const inner = n
          ? `${label ? `<div style="font-size:${Math.round(size * .6)}px;color:${color};opacity:.75">${esc(label)}</div>` : ''}<div style="font-size:${size}px;color:${color};font-weight:700;line-height:1.1">${esc(n.title)}</div><div style="font-size:${Math.round(size * .6)}px;color:${color};opacity:.85">${hm(n.start_at, ctx.fmt)} – ${hm(n.end_at, ctx.fmt)}</div>`
          : `<div style="font-size:${size}px;color:${color};opacity:.8">${esc(p.emptyText || 'No more meetings today')}</div>`;
        return wrap(inner, 'display:flex;flex-direction:column;justify-content:center;');
      }
      case 'schedule': {
        const rows = (ctx.live || []).slice(0, p.count || 5).map(b => `<div class="dz-row" style="font-size:${size}px;color:${color}"><b>${hm(b.start_at, ctx.fmt)}</b><span>${esc(b.title)}</span><i>${esc(b.organizer || '')}</i></div>`).join('');
        return wrap(rows || `<div style="font-size:${size}px;color:${color};opacity:.7">No meetings</div>`, 'display:flex;flex-direction:column;justify-content:flex-start;gap:.4em;overflow:hidden;');
      }
      case 'facilities': {
        const chips = (ctx.room?.facilities || []).map(f => `<span style="font-size:${size}px;color:${color};padding:.25em .7em;border-radius:999px;border:2px solid ${color}55;">${esc(f)}</span>`).join('');
        return wrap(chips || `<span style="font-size:${size}px;color:${color};opacity:.6">No facilities listed</span>`, 'display:flex;flex-wrap:wrap;align-content:flex-start;gap:.5em;');
      }
      case 'shape':
        return wrap('', `background:${p.fill || '#22324c'};border-radius:${p.radius ?? 24}px;opacity:${p.opacity ?? 1};`);
    }
    return '';
  }

  // data: { room, current, next, live, settings, now (Date), offsetMs }
  function mount(container, design, data, opts = {}) {
    if (container._timer) clearInterval(container._timer);
    const base = BASE[design.orientation] || BASE.landscape;
    const cw = container.clientWidth || window.innerWidth, ch = container.clientHeight || window.innerHeight;
    const s = Math.min(cw / base.w, ch / base.h);
    const ox = (cw - base.w * s) / 2, oy = (ch - base.h * s) / 2;
    const state = data.current ? 'busy' : 'free';
    const ctx = { room: data.room, current: data.current, next: data.next, live: data.live || [], fmt: data.settings?.time_format || '12', now: data.now || new Date(), selected: opts.selected };
    const visible = (design.elements || []).filter(e => e.show === 'always' || e.show === undefined || e.show === state);
    container.innerHTML = `<div class="dz-stage" style="width:${base.w}px;height:${base.h}px;background:${design.bg || '#0e1522'};transform:translate(${ox}px,${oy}px) scale(${s});">
      ${visible.map(e => elementHtml(e, ctx, !!opts.editable)).join('')}
    </div>`;
    const stage = container.querySelector('.dz-stage');
    stage.style.position = 'absolute'; stage.style.left = '0'; stage.style.top = '0'; stage.style.transformOrigin = '0 0';
    if (container.style.position !== 'absolute' && getComputedStyle(container).position === 'static') container.style.position = 'relative';
    container.style.overflow = 'hidden';
    // clock: update in place every 15s, without rebuilding the page
    const off = data.offsetMs || 0;
    container._timer = setInterval(() => {
      const now = new Date(Date.now() + off);
      container.querySelectorAll('.dz-clock-time').forEach(n => { n.textContent = clockText('time', now, ctx.fmt).time; });
      container.querySelectorAll('.dz-clock-date').forEach(n => { n.textContent = clockText('date', now, ctx.fmt).date; });
    }, 15000);
    return stage;
  }

  window.RFDesign = { mount, BASE };
})();
