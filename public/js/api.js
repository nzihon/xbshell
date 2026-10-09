// api.js — REST 客户端封装
const API = {
  async get(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    return r.json();
  },
  async post(url, body) {
    const r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  },
  async put(url, body) {
    const r = await fetch(url, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  },
  async del(url) {
    const r = await fetch(url, { method: 'DELETE' });
    return r.json().catch(() => ({}));
  },
  sessions: {
    list: () => API.get('/api/sessions'),
    create: (s) => API.post('/api/sessions', s),
    update: (id, s) => API.put('/api/sessions/' + id, s),
    remove: (id) => API.del('/api/sessions/' + id)
  },
  settings: {
    get: () => API.get('/api/settings'),
    save: (s) => API.post('/api/settings', s)
  },
  keys: {
    list: () => API.get('/api/keys'),
    import: (name, content) => API.post('/api/keys', { name, content }),
    remove: (name) => API.del('/api/keys/' + encodeURIComponent(name))
  },
  tunnels: {
    list: () => API.get('/api/tunnels'),
    start: (t) => API.post('/api/tunnels', t),
    stop: (id) => API.del('/api/tunnels/' + id)
  },
  logs: {
    list: () => API.get('/api/logs'),
    remove: (name) => API.del('/api/logs/' + encodeURIComponent(name)),
    content: (name) => fetch('/api/logs/' + encodeURIComponent(name)).then(r => r.text())
  }
};
