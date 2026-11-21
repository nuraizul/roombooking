// Keeps uploaded videos and photos on the tablet, so they play without a network.
// YouTube and other web links are not cached: they need the internet.
(function () {
  const CACHE = 'rf-media-v1';

  function failed(el) {
    const ph = document.createElement('div');
    ph.className = 'dz-placeholder';
    ph.textContent = 'Wi-Fi disconnected';
    el.replaceWith(ph);
  }

  async function setSource(el, url) {
    if (url.startsWith('/uploads/')) {
      const cache = await caches.open(CACHE).catch(() => null);
      let res = cache ? await cache.match(url) : null;
      if (!res) {
        try {
          const net = await fetch(url, { cache: 'no-cache' });
          if (!net.ok) throw new Error(net.status);
          if (cache) cache.put(url, net.clone()).catch(() => {});
          res = net;
        } catch (_) { res = null; }
      }
      if (!res) return failed(el);
      el.src = URL.createObjectURL(await res.blob());
    } else {
      el.src = url;
    }
    if (el.tagName === 'VIDEO') el.load();
  }

  // call after a design is drawn: starts loading each media element once
  function prepare(root) {
    root.querySelectorAll('[data-media]').forEach(el => {
      const url = el.dataset.media;
      if (!url || el.dataset.ready === url) return;
      el.dataset.ready = url;
      setSource(el, url).catch(() => failed(el));
    });
  }

  window.RFMedia = { prepare };
})();
