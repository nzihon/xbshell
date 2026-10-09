// sftp.js — SFTP 文件浏览器面板
class SftpPane {
  constructor(container, sessionId, override) {
    this.container = container;
    this.sessionId = sessionId;
    this.override = override || null;
    this.ws = null;
    this.cwd = '/';
    this.entries = [];
    this.rendered = false;
    this._build();
  }

  _build() {
    this.container.innerHTML = `
      <div class="sftp-toolbar">
        <button class="btn small sftp-up">⬆ 上级</button>
        <input class="sftp-path" readonly />
        <button class="btn small sftp-refresh">刷新</button>
        <button class="btn small sftp-upload-btn">上传</button>
        <button class="btn small sftp-mkdir">新建目录</button>
        <input type="file" class="sftp-file-input" multiple style="display:none" />
      </div>
    <div class="sftp-body">
      <div class="sftp-list"><table class="sftp-table">
        <thead><tr><th>名称</th><th>大小</th><th>修改时间</th><th></th></tr></thead>
        <tbody class="sftp-rows"></tbody>
      </table></div>
    </div>
    <div class="sftp-drop-hint">松开鼠标上传到当前目录</div>
  `;
    this.rendered = true;
    this.pathEl = this.container.querySelector('.sftp-path');
    this.rowsEl = this.container.querySelector('.sftp-rows');

    this.container.querySelector('.sftp-up').onclick = () => this.cd('..');
    this.container.querySelector('.sftp-refresh').onclick = () => this.send({ type: 'sftp_list', path: this.cwd });
    this.container.querySelector('.sftp-mkdir').onclick = async () => {
      const n = await App._prompt('目录名:', { title: '新建目录' });
      if (n) this.send({ type: 'sftp_mkdir', name: n });
    };
    const fi = this.container.querySelector('.sftp-file-input');
    this.container.querySelector('.sftp-upload-btn').onclick = () => fi.click();
    fi.onchange = () => {
      if (fi.files && fi.files.length) this._uploadFiles(fi.files);
      fi.value = ''; // 清空,允许重复选择同一批文件
    };

    // 拖拽文件到面板 → 上传到当前目录
    this._bindDragUpload();
  }

  connect() {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws/sftp`);
      this.ws = ws;
      ws.onopen = () => ws.send(JSON.stringify({ type: 'sftp_connect', sessionId: this.sessionId, path: '.', override: this.override }));
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.type === 'sftp_ready') { this.cwd = m.cwd; this.pathEl.value = m.cwd; resolve(); }
        else if (m.type === 'sftp_list') { this.cwd = m.path; this.pathEl.value = m.path; this._render(m.entries); }
        else if (m.type === 'sftp_file') { this._download(m); }
        else if (m.type === 'sftp_uploaded') {
          if (App && App._finishUpload) App._finishUpload(m.uploadId, true, m.name);
          this.send({ type: 'sftp_list', path: this.cwd });
        }
        else if (m.type === 'error') { reject(new Error(m.message)); }
      };
      ws.onerror = () => reject(new Error('SFTP 连接失败'));
    });
  }

  send(obj) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }
  cd(p) { this.send({ type: 'sftp_list', path: p === '..' ? this._parent(this.cwd) : p }); }
  _parent(p) { const parts = p.split('/').filter(Boolean); parts.pop(); return '/' + parts.join('/'); }

  _render(entries) {
    this.entries = entries;
    this.rowsEl.innerHTML = '';
    if (this.cwd !== '/') {
      this._addRow('..', '目录', '', true, () => this.cd('..'));
    }
    for (const e of entries) {
      const isDir = e.isDir;
      const size = isDir ? '—' : this._fmtSize(e.size);
      const time = e.mtime ? new Date(e.mtime).toLocaleString() : '';
      const fullPath = this._join(this.cwd, e.name);
      this._addRow(e.name, size, time, isDir, () => {
        if (isDir) this.cd(fullPath);
        else this.send({ type: 'sftp_download', path: fullPath });
      });
    }
  }

  _join(dir, name) { return (dir === '/' ? '' : dir) + '/' + name; }

  _addRow(name, size, time, isDir, onclick) {
    const tr = document.createElement('tr');
    const icon = isDir ? '📁' : '📄';
    tr.innerHTML = `<td class="name">${icon} ${this._esc(name)}</td><td class="size">${size}</td><td class="mtime">${time}</td><td></td>`;
    tr.onclick = onclick;
    // 右键菜单:删除/重命名
    tr.oncontextmenu = (e) => {
      e.preventDefault();
      const fullPath = this._join(this.cwd, name);
      App.showCtxMenu([
        { label: isDir ? '打开' : '下载', onClick: () => { if (isDir) this.cd(fullPath); else this.send({ type: 'sftp_download', path: fullPath }); } },
        { label: '重命名', onClick: async () => { const nn = await App._prompt('重命名为:', { defaultValue: name, title: '重命名' }); if (nn && nn !== name) this.send({ type: 'sftp_rename', path: fullPath, newPath: this._join(this.cwd, nn) }); } },
        { sep: true },
        { label: '删除', onClick: async () => { if (await App._confirm(`删除「${name}」?`, '删除确认')) this.send({ type: isDir ? 'sftp_rmdir' : 'sftp_rm', path: fullPath }); } }
      ], e.clientX, e.clientY);
    };
    this.rowsEl.appendChild(tr);
  }

  _esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  _fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  // 单文件分块上传(带进度条):每 256KB 一块,逐块发送,进度回写到全局上传浮层
  _uploadOne(file) {
    const CHUNK = 256 * 1024;
    const total = Math.max(1, Math.ceil(file.size / CHUNK));
    const uploadId = 'u' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    if (App && App._addUploadItem) App._addUploadItem(uploadId, file.name);
    this.send({ type: 'sftp_upload_start', uploadId, name: file.name, total });
    let index = 0;
    const sendNext = () => {
      if (index >= total) {
        this.send({ type: 'sftp_upload_end', uploadId });
        return;
      }
      const start = index * CHUNK;
      const end = Math.min(file.size, start + CHUNK);
      const blob = file.slice(start, end);
      const reader = new FileReader();
      reader.onload = () => {
        const data = reader.result.split(',')[1];
        this.send({ type: 'sftp_upload_chunk', uploadId, index, data });
        index++;
        if (App && App._updateUploadProgress) App._updateUploadProgress(uploadId, Math.round(index / total * 100));
        sendNext();
      };
      reader.onerror = () => { if (App && App._finishUpload) App._finishUpload(uploadId, false, '读取失败'); };
      reader.readAsDataURL(blob);
    };
    sendNext();
  }

  // 批量上传(拖拽 / 多选共用):逐个走分块上传,上传到当前 cwd(服务端按 cwd 落盘)
  _uploadFiles(fileList) {
    const files = Array.from(fileList || []).filter(f => f && f.name);
    if (!files.length) return;
    if (App && App._toast) App._toast(`开始上传 ${files.length} 个文件…`);
    for (const f of files) this._uploadOne(f);
  }

  // 拖拽上传:进入/移动高亮,松开后上传;用计数器避免子元素 dragleave 误关高亮
  _bindDragUpload() {
    const c = this.container;
    let depth = 0;
    c.addEventListener('dragenter', (e) => {
      if (!this._isFileDrag(e)) return;
      e.preventDefault();
      depth++;
      c.classList.add('drag-over');
    });
    c.addEventListener('dragover', (e) => {
      if (!this._isFileDrag(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      c.classList.add('drag-over');
    });
    c.addEventListener('dragleave', (e) => {
      if (!this._isFileDrag(e)) return;
      e.preventDefault();
      depth = Math.max(0, depth - 1);
      if (depth === 0) c.classList.remove('drag-over');
    });
    c.addEventListener('drop', (e) => {
      if (!this._isFileDrag(e)) return;
      e.preventDefault();
      e.stopPropagation(); // 阻止冒泡到全局 drop,避免重复上传
      depth = 0;
      c.classList.remove('drag-over');
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) this._uploadFiles(files);
    });
  }

  _isFileDrag(e) {
    const dt = e.dataTransfer;
    if (!dt || !dt.types) return false;
    try { return Array.from(dt.types).indexOf('Files') >= 0; } catch (err) { return true; }
  }

  _download(m) {
    const bytes = atob(m.data);
    const buf = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
    const blob = new Blob([buf]);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = m.name;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  close() { if (this.ws) this.ws.close(); }
}
