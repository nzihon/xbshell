// app.js — 主应用逻辑
const App = {
  sessions: [],
  settings: { theme: 'dark-blue', fontSize: 14, fontFamily: 'Consolas, "Courier New", monospace' },
  tabs: [],           // { id, type, title, session, terminal?, sftp?, status }
  activeTabId: null,
  editingSessionId: null,
  selectedTabIds: new Set(), // 广播多选的标签
  broadcastOn: false,
  selectedSessionIds: new Set(), // 会话树多选
  layoutMode: 'tab', // 'tab' | 'hsplit' | 'vsplit'

  async init() {
    this.settings = await API.settings.get();
    this.applyTheme();
    this.bindEvents();
    await this.refreshSessions();
    await this.loadKeys();
    this.renderQuickBar();
    this.renderTunnelSessions();
  },

  // ---------- 会话 ----------
  async refreshSessions() {
    this.sessions = await API.sessions.list();
    this.renderTree();
  },

  renderTree() {
    const el = document.getElementById('session-tree');
    const q = (document.getElementById('session-search').value || '').trim().toLowerCase();
    const groups = {};
    for (const s of this.sessions) {
      if (q) {
        const hay = ((s.name || '') + ' ' + (s.host || '') + ' ' + (s.username || '') + ' ' + (s.group || '')).toLowerCase();
        if (!hay.includes(q)) continue;
      }
      const g = s.group || '未分组';
      (groups[g] = groups[g] || []).push(s);
    }
    el.innerHTML = '';
    for (const g in groups) {
      const wrap = document.createElement('div');
      wrap.className = 'tree-group';
      wrap.innerHTML = `
        <div class="tree-group-head"><span class="arrow">▼</span><span>${this.esc(g)} (${groups[g].length})</span></div>
        <div class="tree-group-body"></div>`;
      const body = wrap.querySelector('.tree-group-body');
      for (const s of groups[g]) {
        const item = document.createElement('div');
        item.className = 'tree-item' + (this.selectedSessionIds.has(s.id) ? ' selected' : '');
        item.dataset.id = s.id;
        item.innerHTML = `<span class="sicon">🖥</span><span class="sname">${this.esc(s.name || s.host)}</span>
          <span class="sacts">
            <button title="连接" data-act="connect">▶</button>
            <button title="编辑" data-act="edit">✎</button>
            <button title="删除" data-act="del">🗑</button>
          </span>`;
        item.onclick = (e) => {
          const act = e.target.closest('[data-act]');
          if (act) {
            e.stopPropagation();
            const a = act.dataset.act;
            if (a === 'connect') this.connectSession(s.id);
            else if (a === 'edit') this.editSession(s.id);
            else if (a === 'del') this.deleteSession(s.id);
            return;
          }
          if (e.ctrlKey || e.metaKey) {
            if (this.selectedSessionIds.has(s.id)) this.selectedSessionIds.delete(s.id);
            else this.selectedSessionIds.add(s.id);
            this.renderTree();
            return;
          }
          // 单击延时执行「编辑」,若 260ms 内出现双击则取消编辑、改为「连接」,
          // 避免单击先弹编辑框、弹窗遮罩把双击吃掉导致快速连接失效
          if (this._treeDblTimer) { clearTimeout(this._treeDblTimer); this._treeDblTimer = null; }
          this._treeDblTimer = setTimeout(() => { this._treeDblTimer = null; this.editSession(s.id); }, 260);
        };
        item.ondblclick = (e) => {
          if (this._treeDblTimer) { clearTimeout(this._treeDblTimer); this._treeDblTimer = null; }
          this.connectSession(s.id);
        };
        item.oncontextmenu = (e) => { e.preventDefault(); this.showSessionCtxMenu(s.id, e.clientX, e.clientY); };
        body.appendChild(item);
      }
      wrap.querySelector('.tree-group-head').onclick = () => wrap.classList.toggle('collapsed');
      el.appendChild(wrap);
    }
  },

  async deleteSession(id) {
    if (!(await this._confirm('确定删除该会话?'))) return;
    await API.sessions.remove(id);
    await this.refreshSessions();
  },

  // ---------- 标签页 ----------
  // 统一标题结构:名称在前、连接信息在括号,如「生产服务器 (root@192.168.1.10)」;
  // 无名称时仅显示 root@host,无连接信息时仅显示名称。标签页与分屏窗口复用同一标题。
  buildTitle(session, type) {
    const s = session || {};
    const name = (s.name || '').trim();
    const conn = (s.username && s.host) ? (s.username + '@' + s.host) : (s.host || '');
    let title;
    if (name && conn) title = name + ' (' + conn + ')';
    else if (name) title = name;
    else if (conn) title = conn;
    else title = '会话';
    if (type === 'sftp') title = 'SFTP: ' + title;
    return title;
  },

  createTab(type, session) {
    const id = 'tab-' + Date.now();
    const tab = { id, type, session, title: this.buildTitle(session, type), status: 'idle' };
    this.tabs.push(tab);
    this.renderTabs();
    this.activateTab(id);
    return tab;
  },

  closeTab(id) {
    const i = this.tabs.findIndex(t => t.id === id);
    if (i < 0) return;
    const tab = this.tabs[i];
    if (tab.terminal) tab.terminal.destroy();
    if (tab.sftp) tab.sftp.close();
    // 关键:同步移除窗口 DOM 节点。否则关闭会话后,残留的绝对定位层(inset:0)
    // 会覆盖在欢迎页之上,导致「新建会话/快速连接」等按钮无法点击
    const wrap = document.getElementById('wrap-' + id);
    if (wrap) wrap.remove();
    this.tabs.splice(i, 1);
    this.selectedTabIds.delete(id);
    this.updateBroadcastTargets();
    this.renderTabs();
    if (this.activeTabId === id) {
      this.activateTab(this.tabs.length ? this.tabs[this.tabs.length - 1].id : null);
    }
    this.applyLayout();
  },

  activateTab(id) {
    const changed = this.activeTabId !== id;
    this.activeTabId = id;
    const tabs = document.querySelectorAll('.tab');
    tabs.forEach(t => t.classList.toggle('active', t.dataset.id === id));
    const tab = this.tabs.find(t => t.id === id);
    if (!tab) {
      if (this.layoutMode === 'tab') document.getElementById('welcome').style.display = 'flex';
      // 兜底:清掉所有窗口的激活态,避免残留绝对定位层遮挡欢迎页
      document.querySelectorAll('.term-wrap, .sftp-wrap').forEach(w => w.classList.remove('active'));
      if (changed) this.refreshMonitorIfOpen();
      return;
    }
    // 统一同步 wrap 的 active 标记:单标签模式控制显隐,分屏模式用于高亮激活窗口
    const wraps = document.querySelectorAll('.term-wrap, .sftp-wrap');
    wraps.forEach(w => w.classList.toggle('active', w.id === 'wrap-' + id));
    if (this.layoutMode === 'tab') {
      document.getElementById('welcome').style.display = 'none';
      if (tab.terminal) tab.terminal.refit();
    }
    this.renderQuickBar();
    this.updateStatus(tab);
    // 切换激活窗口时立即刷新监控面板(否则要等 2s 轮询,表现为「还显示上一个/无会话」)
    if (changed) this.refreshMonitorIfOpen();
  },

  renderTabs() {
    const bar = document.getElementById('tabbar');
    bar.innerHTML = '';
    for (const t of this.tabs) {
      const el = document.createElement('div');
      el.className = 'tab'
        + (t.id === this.activeTabId ? ' active' : '')
        + (this.selectedTabIds.has(t.id) ? ' selected' : '');
      el.dataset.id = t.id;
      el.title = t.title || '';
      const dotCls = t.status === 'ready' ? 'on' : '';
      el.innerHTML = `<span class="t-status ${dotCls}"></span><span class="t-title">${this.esc(t.title)}</span><button class="tclose">✕</button>`;
      el.onclick = (e) => {
        if (e.ctrlKey || e.metaKey) this.toggleTabSelect(t.id);
        else this.activateTab(t.id);
      };
      el.oncontextmenu = (e) => { e.preventDefault(); this.showTabCtxMenu(t.id, e.clientX, e.clientY); };
      el.querySelector('.tclose').onclick = (e) => { e.stopPropagation(); this.closeTab(t.id); };
      bar.appendChild(el);
    }
    if (!this.tabs.length) {
      const welcome = document.getElementById('welcome');
      welcome.style.display = 'flex';
    }
    this.syncTermTitles();
  },

  // 同步垂直分屏窗口顶部的标题栏(标题/状态点与标签页保持一致)
  syncTermTitles() {
    for (const t of this.tabs) {
      const el = document.querySelector(`#wrap-${t.id} .term-title`);
      if (!el) continue;
      el.querySelector('.t-title').textContent = t.title || '';
      el.title = t.title || '';
      el.querySelector('.t-status').className = 't-status ' + (t.status === 'ready' ? 'on' : '');
    }
  },

  updateStatus(tab) {
    const dot = document.getElementById('status-dot');
    const txt = document.getElementById('status-text');
    let base = '';
    if (tab && tab.status === 'ready') { dot.className = 'dot on'; base = '已连接 ' + tab.title; }
    else if (tab && tab.status === 'connecting') { dot.className = 'dot'; base = '连接中…'; }
    else { dot.className = 'dot'; base = '未连接'; }
    if (this.broadcastOn) {
      const n = this._broadcastTargets().length;
      base += ` · 📡 广播输入已开启(${n} 个会话)`;
    }
    txt.textContent = base;
    // 更新 tab 状态点
    const tEl = document.querySelector(`.tab[data-id="${tab ? tab.id : ''}"] .t-status`);
    if (tEl) tEl.className = 't-status ' + (tab.status === 'ready' ? 'on' : '');
  },

  // ---------- 广播输入 ----------
  // 广播组 = 勾选的标签(selectedTabIds),与激活窗口解耦:
  // Ctrl+点击加入/退出,退出即时生效,无需全部取消重来
  toggleTabSelect(id) {
    if (this.selectedTabIds.has(id)) {
      this.selectedTabIds.delete(id); // 退出广播组(不切换激活窗口,避免又被自动加回)
    } else {
      this.selectedTabIds.add(id);
      this.activateTab(id);
    }
    this.renderTabs();
    this.updateBroadcastTargets();
    this.updateStatus(this.tabs.find(t => t.id === this.activeTabId));
  },

  toggleBroadcast() {
    this.broadcastOn = !this.broadcastOn;
    const btn = document.getElementById('btn-broadcast');
    if (btn) btn.classList.toggle('active', this.broadcastOn);
    // 开启广播时一个都没勾选 → 默认把当前激活窗口加入广播组
    if (this.broadcastOn && !this.selectedTabIds.size && this.activeTabId) {
      this.selectedTabIds.add(this.activeTabId);
    }
    this.renderTabs();
    this.updateBroadcastTargets();
    this.updateStatus(this.tabs.find(t => t.id === this.activeTabId));
    if (this.broadcastOn) {
      const n = this._broadcastTargets().length;
      if (n < 2) this._toast(`广播已开启,当前 ${n} 个会话。Ctrl+点击标签可加入/退出广播组`);
    }
  },

  _broadcastTargets() {
    return this.tabs.filter(t => this.selectedTabIds.has(t.id) && t.terminal && t.terminal.state === 'ready');
  },

  updateBroadcastTargets() {
    this.tabs.forEach(t => { if (t.terminal) t.terminal.broadcastTo = []; });
    // 同步分屏窗口的广播高亮(绿色边框 = 在广播组内)
    this.tabs.forEach(t => {
      const w = document.getElementById('wrap-' + t.id);
      if (w) w.classList.toggle('selected', this.broadcastOn && this.selectedTabIds.has(t.id));
    });
    if (!this.broadcastOn) return;
    const targets = this._broadcastTargets();
    if (targets.length < 2) return;
    for (const t of targets) {
      t.terminal.broadcastTo = targets.filter(x => x !== t).map(x => x.terminal);
    }
  },

  _toast(msg) {
    let el = document.getElementById('toast');
    if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
  },

  // ---------- 自定义对话框(替代原生 alert/confirm/prompt,避免 Electron 下阻塞卡死) ----------
  _confirm(msg, title = '确认') {
    return new Promise((resolve) => {
      document.getElementById('confirm-label').textContent = msg;
      document.getElementById('confirm-title').textContent = title;
      this._confirmResolveFn = resolve;
      this.showModal('modal-confirm');
    });
  },
  _confirmResolve(val) {
    this.closeModal('modal-confirm');
    if (this._confirmResolveFn) { const r = this._confirmResolveFn; this._confirmResolveFn = null; r(val); }
  },

  _prompt(label, { defaultValue = '', password = false, title = '输入' } = {}) {
    return new Promise((resolve) => {
      document.getElementById('prompt-label').textContent = label;
      document.getElementById('prompt-title').textContent = title;
      const inp = document.getElementById('prompt-input');
      inp.type = password ? 'password' : 'text';
      inp.value = defaultValue;
      this._promptResolveFn = resolve;
      this.showModal('modal-prompt');
      setTimeout(() => inp.focus(), 60);
    });
  },
  _promptSubmit() {
    const val = document.getElementById('prompt-input').value;
    this.closeModal('modal-prompt');
    if (this._promptResolveFn) { const r = this._promptResolveFn; this._promptResolveFn = null; r(val); }
  },
  _promptResolve(val) {
    this.closeModal('modal-prompt');
    if (this._promptResolveFn) { const r = this._promptResolveFn; this._promptResolveFn = null; r(val); }
  },

  // ---------- 布局(单标签/水平/垂直分屏) ----------
  showLayoutMenu(x, y) {
    const items = [
      { label: '单标签', kbd: this.layoutMode === 'tab' ? '✓' : '', onClick: () => this.setLayout('tab') },
      { label: '水平排列', kbd: this.layoutMode === 'hsplit' ? '✓' : '', onClick: () => this.setLayout('hsplit') },
      { label: '垂直排列', kbd: this.layoutMode === 'vsplit' ? '✓' : '', onClick: () => this.setLayout('vsplit') }
    ];
    this.showCtxMenu(items, x, y);
  },

  setLayout(mode) {
    this.layoutMode = mode;
    this.applyLayout();
  },

  applyLayout() {
    const content = document.getElementById('content');
    content.classList.remove('layout-hsplit', 'layout-vsplit');
    // 分屏标签对齐:
    // - 水平排列:顶部标签栏横向平分,每个标签对齐到自己窗口正上方;
    // - 垂直排列:隐藏顶部标签栏,每个窗口顶部自带标题栏(与窗口同宽、跟随窗口);
    // - 单标签:标签栏自然宽度靠左。
    const tabbar = document.getElementById('tabbar');
    tabbar.classList.toggle('layout-split', this.layoutMode === 'hsplit');
    tabbar.classList.toggle('layout-vsplit', this.layoutMode === 'vsplit');
    // 清除所有 split 显示
    document.querySelectorAll('.term-wrap').forEach(w => w.classList.remove('split-visible'));
    document.getElementById('welcome').style.display = 'none';

    if (this.layoutMode === 'hsplit' || this.layoutMode === 'vsplit') {
      content.classList.add('layout-' + this.layoutMode);
      // 分屏仅针对终端;隐藏 SFTP 面板
      document.querySelectorAll('.sftp-wrap').forEach(w => w.classList.remove('active'));
      const readyTabs = this.tabs.filter(t => t.terminal && t.terminal.state === 'ready');
      // 标题栏宽度按可见窗口数均分(与水平排列标签等宽),供 CSS var(--split-count) 使用
      content.style.setProperty('--split-count', Math.max(1, readyTabs.length));
      for (const t of readyTabs) {
        const wrap = document.getElementById('wrap-' + t.id);
        if (wrap) wrap.classList.add('split-visible');
      }
      // 让每个可见终端重新计算尺寸
      readyTabs.forEach(t => setTimeout(() => t.terminal.refit(), 30));
    } else {
      // 单标签模式:恢复 active 标签显示
      const active = this.tabs.find(t => t.id === this.activeTabId);
      if (active) {
        const wrap = document.getElementById('wrap-' + this.activeTabId);
        if (wrap) { wrap.classList.add('active'); if (active.terminal) active.terminal.refit(); }
      } else {
        document.getElementById('welcome').style.display = 'flex';
      }
    }
  },

  // ---------- 连接 ----------
  async connectSession(id) {
    const s = this.sessions.find(x => x.id === id);
    if (!s) return;
    // 仅 SSH 且未保存密码时弹出输入;Telnet/Rlogin 为终端内交互式登录
    let override = null;
    if ((s.protocol || 'ssh') === 'ssh' && !s.hasPassword && s.authType !== 'key') {
      const pw = await this._prompt(`请输入 ${s.username}@${s.host} 的密码:`, { password: true, title: '密码认证' });
      if (pw === null || pw === '') return;
      override = { password: pw };
    }
    this.openTerminalForSession(id, s, override);
  },

  async openTerminalForSession(id, s, override) {
    const tab = this.createTab('terminal', s);
    tab.status = 'connecting';
    this.renderTabs();

    const wrap = document.createElement('div');
    wrap.className = 'term-wrap active';
    wrap.id = 'wrap-' + tab.id;
    // 垂直分屏时每个窗口顶部显示自己的标题栏(单标签/水平分屏自动隐藏,见 CSS)
    wrap.innerHTML = '<div class="term-title"><div class="tt-inner"><span class="t-status"></span><span class="t-title"></span><button class="tclose">✕</button></div></div><div class="term-body"></div>';
    document.getElementById('content').appendChild(wrap);

    // 点击窗口:普通点击激活;标题栏 Ctrl+点击 切换广播选中(垂直分屏无标签栏,靠标题栏选中);
    // 标题栏 ✕ 关闭该会话
    wrap.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.tclose')) return; // ✕ 关闭按钮不参与激活/选中
      if (e.target.closest('.term-title') && (e.ctrlKey || e.metaKey)) this.toggleTabSelect(tab.id);
      else this.activateTab(tab.id);
    }, true);
    const titleClose = wrap.querySelector('.term-title .tclose');
    if (titleClose) titleClose.onclick = (e) => { e.stopPropagation(); this.closeTab(tab.id); };
    this.syncTermTitles();

    const term = new TerminalSession(wrap.querySelector('.term-body'), {
      onState: (st) => { tab.status = st; this.updateStatus(tab); this.renderTabs(); }
    });
    tab.terminal = term;
    try {
      await term.connect(id, override);
      tab.status = 'ready';
      this.updateStatus(tab);
      this.updateBroadcastTargets();
      this.renderTabs();
      this.renderQuickBar();
      this.applyLayout();
      this.refreshMonitorIfOpen();
      term.focus();
    } catch (e) {
      tab.status = 'closed';
      this.updateStatus(tab);
    }
  },

  async reconnectActive() {
    const tab = this.tabs.find(t => t.id === this.activeTabId);
    if (!tab) { this.quickConnect(); return; }
    if (tab.type === 'sftp') { this._toast('请切换到终端标签后再连接'); return; }
    const s = tab.session;
    // 已连接则新开一个标签
    if (tab.terminal && tab.terminal.state === 'ready') {
      if (s && s.id) this.connectSession(s.id);
      else this.quickConnect();
      return;
    }
    // 快速连接会话无持久化凭据,重连需重新输入
    if (!s || !s.id) { this.quickConnect(); return; }
    let override = null;
    if ((s.protocol || 'ssh') === 'ssh' && !s.hasPassword && s.authType !== 'key') {
      const pw = await this._prompt(`请输入 ${s.username}@${s.host} 的密码:`, { password: true, title: '密码认证' });
      if (pw === null || pw === '') return;
      override = { password: pw };
    }
    tab.status = 'connecting';
    this.renderTabs(); this.updateStatus(tab);
    try {
      await tab.terminal.connect(s.id, override);
      tab.status = 'ready';
      tab.terminal.focus();
      this.updateStatus(tab); this.renderTabs(); this.renderQuickBar();
    } catch (e) {
      tab.status = 'closed';
      this.updateStatus(tab);
    }
  },

  disconnectActive() {
    const tab = this.tabs.find(t => t.id === this.activeTabId);
    if (tab && tab.terminal) tab.terminal.disconnect();
  },

  // ---------- 快捷命令 ----------
  renderQuickBar() {
    const bar = document.getElementById('quick-bar');
    bar.innerHTML = '';
    const tab = this.tabs.find(t => t.id === this.activeTabId);
    const cmds = tab && tab.session && tab.session.quickCommands ? tab.session.quickCommands : [];
    for (const c of cmds) {
      const b = document.createElement('button');
      b.className = 'qbtn';
      b.textContent = c;
      b.title = '发送命令: ' + c;
      b.onclick = () => {
        if (tab && tab.terminal) tab.terminal.paste(c + '\r');
      };
      bar.appendChild(b);
    }
  },

  // ---------- 会话编辑弹窗 ----------
  newSession(initGroup) {
    this.editingSessionId = null;
    document.getElementById('session-modal-title').textContent = '新建会话';
    this.fillSessionForm({ username: 'root', group: initGroup || '' });
    this.showModal('modal-session');
  },

  editSession(id) {
    const s = this.sessions.find(x => x.id === id);
    if (!s) return;
    this.editingSessionId = id;
    document.getElementById('session-modal-title').textContent = '编辑会话 - ' + (s.name || s.host);
    this.fillSessionForm(s);
    this.showModal('modal-session');
  },

  fillSessionForm(s) {
    document.getElementById('f-name').value = s.name || '';
    document.getElementById('f-group').value = s.group || '';
    document.getElementById('f-host').value = s.host || '';
    document.getElementById('f-port').value = s.port || 22;
    document.getElementById('f-protocol').value = s.protocol || 'ssh';
    document.getElementById('f-username').value = s.username || '';
    document.getElementById('f-authType').value = s.authType || 'password';
    this._clearPassword = false; // 重置「清除密码」标记
    document.getElementById('f-password').value = ''; // 不回显
    document.getElementById('f-password').placeholder = s.hasPassword ? '已保存密码(留空保持不变)' : '留空表示每次连接时输入';
    const clearPwBtn = document.getElementById('btn-clear-password');
    if (clearPwBtn) clearPwBtn.style.display = s.hasPassword ? '' : 'none';
    document.getElementById('f-keyName').value = s.keyName || '';
    document.getElementById('f-passphrase').value = '';
    document.getElementById('f-term').value = s.term || 'xterm-256color';
    document.getElementById('f-keepalive').checked = s.keepalive !== false;
    document.getElementById('f-logSession').checked = !!s.logSession;
    document.getElementById('f-quickCommands').value = (s.quickCommands || []).join('\n');
    this.toggleAuthFields();
    this.toggleProtocolFields();
  },

  // 协议切换:端口联动 + 认证项显隐(Telnet/Rlogin 为交互式登录)
  toggleProtocolFields() {
    const p = document.getElementById('f-protocol').value;
    const portEl = document.getElementById('f-port');
    const cur = parseInt(portEl.value, 10) || 0;
    const defaults = { ssh: 22, telnet: 23, rlogin: 513 };
    if (!cur || [22, 23, 513].includes(cur)) portEl.value = defaults[p];
    const authTab = document.querySelector('.tabs .tab[data-tab="auth"]');
    if (authTab) authTab.style.display = (p === 'ssh') ? '' : 'none';
    // 非 ssh 协议隐藏认证页(若当前正显示则切回连接页)
    if (p !== 'ssh') {
      const authPage = document.getElementById('tab-auth');
      if (authPage && authPage.classList.contains('active')) {
        authPage.classList.remove('active');
        document.getElementById('tab-connection').classList.add('active');
        document.querySelectorAll('.tabs .tab').forEach(x => x.classList.toggle('active', x.dataset.tab === 'connection'));
      }
    }
  },

  toggleAuthFields() {
    const t = document.getElementById('f-authType').value;
    document.getElementById('auth-password-field').style.display = (t === 'password' || t === 'keyboard-interactive') ? '' : 'none';
    document.getElementById('auth-key-field').style.display = t === 'key' ? '' : 'none';
    document.getElementById('auth-passphrase-field').style.display = t === 'key' ? '' : 'none';
  },

  async saveSession() {
    const body = {
      name: document.getElementById('f-name').value.trim(),
      group: document.getElementById('f-group').value.trim(),
      host: document.getElementById('f-host').value.trim(),
      port: parseInt(document.getElementById('f-port').value, 10) || 22,
      protocol: document.getElementById('f-protocol').value,
      username: document.getElementById('f-username').value.trim(),
      authType: document.getElementById('f-authType').value,
      password: document.getElementById('f-password').value,
      keyName: document.getElementById('f-keyName').value,
      passphrase: document.getElementById('f-passphrase').value,
      term: document.getElementById('f-term').value,
      keepalive: document.getElementById('f-keepalive').checked,
      logSession: document.getElementById('f-logSession').checked,
      quickCommands: document.getElementById('f-quickCommands').value.split('\n').map(x => x.trim()).filter(Boolean)
    };
    // 密码/口令处理:编辑时留空=保持原值不变,避免误清空;点「清除」才显式清空密码
    if (this.editingSessionId) {
      if (this._clearPassword) {
        body.password = ''; // 显式清除已保存密码
      } else if (!body.password) {
        delete body.password; // 留空保持原密码不变
      }
      // 私钥口令同理:留空保持原值,填新值才更新
      if (!body.passphrase) delete body.passphrase;
    }
    if (!body.host) { this._toast('请填写主机'); return; }
    if (body.protocol === 'ssh' && !body.username) { this._toast('SSH 连接需要用户名'); return; }
    try {
      if (this.editingSessionId) await API.sessions.update(this.editingSessionId, body);
      else await API.sessions.create(body);
      this.closeModal('modal-session');
      await this.refreshSessions();
    } catch (e) { this._toast('保存失败: ' + e.message); }
  },

  // ---------- 快速连接 ----------
  quickConnect() { this.showModal('modal-quick'); },

  async doQuickConnect() {
    const protocol = document.getElementById('q-protocol').value;
    const host = document.getElementById('q-host').value.trim();
    const username = document.getElementById('q-username').value.trim();
    const password = document.getElementById('q-password').value;
    const defaults = { ssh: 22, telnet: 23, rlogin: 513 };
    const port = parseInt(document.getElementById('q-port').value, 10) || defaults[protocol];
    if (!host) { this._toast('请输入主机'); return; }
    if (protocol === 'ssh' && !username) { this._toast('SSH 连接需要用户名'); return; }
    this.closeModal('modal-quick');
    // 快速连接无持久化名称,标题直接由 username@host 生成(避免「root@host (root@host)」重复)
    const s = { host, port, protocol, username, authType: 'password', quickCommands: [] };
    this.openTerminalForSession(null, s, { host, port, protocol, username, password });
  },

  // ---------- SFTP ----------
  async openSftp() {
    const tab = this.tabs.find(t => t.id === this.activeTabId);
    if (!tab || !tab.session) { this._toast('请先连接一个会话'); return; }
    const s = tab.session;
    if (!s.id) { this._toast('快速连接会话不支持 SFTP,请先保存为会话'); return; }
    let override = null;
    if (!s.hasPassword && s.authType !== 'key') {
      const pw = await this._prompt(`请输入 ${s.username}@${s.host} 的密码:`, { password: true, title: '密码认证' });
      if (pw === null || pw === '') return;
      override = { password: pw };
    }
    const sTab = this.createTab('sftp', s);
    const wrap = document.createElement('div');
    wrap.className = 'sftp-wrap active';
    wrap.id = 'wrap-' + sTab.id;
    document.getElementById('content').appendChild(wrap);
    const pane = new SftpPane(wrap, s.id, override);
    sTab.sftp = pane;
    try { await pane.connect(); }
    catch (e) { this._toast('SFTP 失败: ' + e.message); this.closeTab(sTab.id); }
  },

  // ---------- 隧道 ----------
  async openTunnel() {
    this.renderTunnelSessions();
    this.refreshTunnelList();
    this.showModal('modal-tunnel');
  },
  renderTunnelSessions() {
    const sel = document.getElementById('t-session');
    sel.innerHTML = this.sessions.map(s => `<option value="${s.id}">${this.esc(s.name || s.host)} (${this.esc(s.username)}@${this.esc(s.host)})</option>`).join('');
  },
  async addTunnel() {
    const sessionId = document.getElementById('t-session').value;
    const s = this.sessions.find(x => x.id === sessionId);
    const mode = document.getElementById('t-mode').value;
    const listenHost = document.getElementById('t-listenHost').value || '127.0.0.1';
    const listenPort = parseInt(document.getElementById('t-listenPort').value, 10);
    const targetHost = document.getElementById('t-targetHost').value || '127.0.0.1';
    const targetPort = parseInt(document.getElementById('t-targetPort').value, 10);
    if (!listenPort || (mode !== 'dynamic' && !targetPort)) { this._toast('请填写端口'); return; }
    let override = null;
    if (s && !s.hasPassword && s.authType !== 'key') {
      const pw = await this._prompt(`请输入 ${s.username}@${s.host} 的密码:`, { password: true, title: '密码认证' });
      if (pw === null || pw === '') return;
      override = { password: pw };
    }
    try {
      await API.tunnels.start({ sessionId, mode, listenHost, listenPort, targetHost, targetPort, override });
      this.refreshTunnelList();
    } catch (e) { this._toast('启动失败: ' + e.message); }
  },
  async refreshTunnelList() {
    const list = await API.tunnels.list();
    document.getElementById('tunnel-list').innerHTML = list.map(t => `
      <div class="tunnel-item"><span>${t.cfg.mode} ${t.cfg.listenHost}:${t.cfg.listenPort} → ${t.cfg.mode === 'dynamic' ? 'SOCKS5' : t.cfg.targetHost + ':' + t.cfg.targetPort}</span>
      <button onclick="App.stopTunnel('${t.id}')">停止</button></div>`).join('');
  },
  async stopTunnel(id) { await API.tunnels.stop(id); this.refreshTunnelList(); },

  // ---------- 密钥 ----------
  async loadKeys() {
    const keys = await API.keys.list();
    const sel = document.getElementById('f-keyName');
    const cur = sel.value;
    sel.innerHTML = keys.map(k => `<option value="${this.esc(k.name)}">${this.esc(k.name)}</option>`).join('');
    if (cur) sel.value = cur;
  },
  async openKeys() {
    await this.loadKeys();
    const list = await API.keys.list();
    document.getElementById('keys-list').innerHTML = list.map(k =>
      `<div class="key-item"><span>${this.esc(k.name)}</span><button onclick="App.deleteKey('${this.esc(k.name)}')">删除</button></div>`).join('');
    this.showModal('modal-keys');
  },
  async importKey() {
    const name = document.getElementById('k-name').value.trim();
    const content = document.getElementById('k-content').value.trim();
    if (!name || !content) { this._toast('请填写名称和私钥内容'); return; }
    try {
      await API.keys.import(name, content);
      document.getElementById('k-content').value = '';
      await this.openKeys();
      await this.loadKeys();
    } catch (e) { this._toast('导入失败: ' + e.message); }
  },
  async deleteKey(name) {
    if (!(await this._confirm('删除私钥 ' + name + '?'))) return;
    await API.keys.remove(name);
    await this.openKeys();
  },

  // ---------- 设置 ----------
  async openSettings() {
    document.getElementById('s-theme').value = this.settings.theme || 'dark';
    document.getElementById('s-fontSize').value = this.settings.fontSize || 14;
    document.getElementById('s-fontFamily').value = this.settings.fontFamily || 'monospace';
    this.showModal('modal-settings');
  },
  async saveSettings() {
    this.settings.theme = document.getElementById('s-theme').value;
    this.settings.fontSize = parseInt(document.getElementById('s-fontSize').value, 10) || 14;
    this.settings.fontFamily = document.getElementById('s-fontFamily').value;
    await API.settings.save(this.settings);
    this.applyTheme();
    this.tabs.forEach(t => t.terminal && t.terminal.reloadTheme());
    this.closeModal('modal-settings');
  },
  applyTheme() {
    const t = this.settings.theme || 'dark-blue';
    document.body.classList.remove('theme-dark', 'theme-light', 'theme-system');
    if (t === 'light') document.body.classList.add('theme-light');
    else if (t === 'dark') document.body.classList.add('theme-dark');
    else if (t === 'system') document.body.classList.add('theme-system');
    // 'dark-blue' 为默认(无 class)
  },

  // ---------- 日志 ----------
  async openLogs() {
    await this.refreshLogs();
    this.showModal('modal-logs');
  },
  async refreshLogs() {
    const logs = await API.logs.list();
    document.getElementById('logs-list').innerHTML = logs.map(l =>
      `<div class="log-item" onclick="App.viewLog('${this.esc(l.name)}')">${this.esc(l.name)} (${this.fmtSize(l.size)})</div>`).join('') ||
      '<span style="color:var(--text-dim)">暂无日志</span>';
  },
  async viewLog(name) {
    const content = await API.logs.content(name);
    document.getElementById('logs-content').textContent = content;
  },

  // ---------- 系统监控(本机 CPU/内存/负载) ----------
  toggleMonitor() {
    const mon = document.getElementById('monitor');
    const hidden = mon.classList.toggle('hidden'); // 返回切换后是否处于隐藏态
    const btn = document.getElementById('btn-monitor');
    if (btn) btn.classList.toggle('active', !hidden); // 打开(可见)时高亮按钮
    if (!hidden) {
      this.refreshMonitor();
      if (!this._monTimer) {
        this._monTimer = setInterval(() => this.refreshMonitor(), 2000);
      }
    }
  },

  // 监控面板可见时立即刷新(用于切换激活窗口/标签后即时更新)
  refreshMonitorIfOpen() {
    const mon = document.getElementById('monitor');
    if (mon && !mon.classList.contains('hidden')) this.refreshMonitor();
  },

  async refreshMonitor() {
    // 每次刷新自增请求序号,丢弃过期的异步结果,避免快速切换窗口时数据错乱
    const req = (this._monReq = (this._monReq || 0) + 1);
    // 绑定当前激活窗口:优先用终端连接的 connId(已保存会话=sessionId,快速连接=随机id,均可用),
    // 回退到会话 id,兼容尚未就绪/非终端标签
    const tab = this.tabs.find(t => t.id === this.activeTabId);
    const sessionId = (tab && tab.terminal && tab.terminal.connId)
      || (tab && tab.session && tab.session.id)
      || null;
    const sessionLabel = (tab && tab.session && tab.session.name) || (tab && tab.title) || '-';
    const reset = (msg) => {
      document.getElementById('m-session').textContent = sessionLabel;
      document.getElementById('m-hostname').textContent = msg;
      document.getElementById('m-platform').textContent = '';
      document.getElementById('m-uptime').textContent = '';
      document.getElementById('m-cpu-count').textContent = '';
      document.getElementById('m-cpu').textContent = '-';
      document.getElementById('m-cpu-bar').style.width = '0%';
      document.getElementById('m-mem').textContent = '-';
      document.getElementById('m-mem-bar').style.width = '0%';
      document.getElementById('m-mem-size').textContent = '-';
      document.getElementById('m-load').textContent = '-';
    };
    if (!sessionId) {
      reset('请先连接一个 SSH 会话');
      return;
    }
    try {
      const s = await API.get('/api/remote-stats?sessionId=' + encodeURIComponent(sessionId));
      if (req !== this._monReq) return; // 期间已切换到其它窗口,丢弃本次结果
      if (!s.connected || s.error) { reset(s.error || '未连接'); return; }
      document.getElementById('m-session').textContent = sessionLabel;
      document.getElementById('m-hostname').textContent = s.hostname;
      document.getElementById('m-platform').textContent = s.platform;
      document.getElementById('m-uptime').textContent = this.fmtUptime(s.uptime);
      document.getElementById('m-cpu-count').textContent = s.cpuCount ? '(' + s.cpuCount + ' 核)' : '';
      document.getElementById('m-cpu').textContent = s.cpu + '%';
      document.getElementById('m-cpu-bar').style.width = s.cpu + '%';
      document.getElementById('m-mem').textContent = s.mem.percent + '%';
      document.getElementById('m-mem-size').textContent = this.fmtBytes(s.mem.used) + ' / ' + this.fmtBytes(s.mem.total);
      document.getElementById('m-mem-bar').style.width = s.mem.percent + '%';
      const load = Array.isArray(s.loadavg) && s.loadavg.some(x => Number(x) > 0)
        ? s.loadavg.map(x => Number(x).toFixed(2)).join(' / ')
        : 'N/A';
      document.getElementById('m-load').textContent = load;
    } catch (e) {
      if (req === this._monReq) reset('监控获取失败');
    }
  },

  fmtUptime(sec) {
    sec = Math.floor(Number(sec) || 0);
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    if (d > 0) return d + ' 天 ' + h + ' 小时';
    if (h > 0) return h + ' 小时 ' + m + ' 分';
    return m + ' 分钟';
  },

  fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  },

  // ---------- 上传进度浮层(非弹窗,右下角) ----------
  _addUploadItem(id, name) {
    const panel = document.getElementById('upload-panel');
    if (!panel) return;
    panel.classList.remove('hidden');
    const list = panel.querySelector('.upload-list');
    const item = document.createElement('div');
    item.className = 'upload-item';
    item.id = 'up-' + id;
    item.innerHTML = `<div class="u-name">${this.esc(name)}</div><div class="upload-bar"><div class="upload-bar-fill"></div></div><div class="u-status">0%</div>`;
    list.appendChild(item);
    panel.scrollTop = panel.scrollHeight;
  },

  _updateUploadProgress(id, pct) {
    const item = document.getElementById('up-' + id);
    if (!item) return;
    item.querySelector('.upload-bar-fill').style.width = pct + '%';
    item.querySelector('.u-status').textContent = pct + '%';
  },

  _finishUpload(id, ok, name) {
    const item = document.getElementById('up-' + id);
    if (!item) return;
    item.classList.add(ok ? 'done' : 'error');
    item.querySelector('.upload-bar-fill').style.width = '100%';
    item.querySelector('.u-status').textContent = ok ? '上传完毕' : '上传失败';
    if (ok) this._toast('文件上传完毕' + (name ? '：' + name : ''));
    else this._toast('上传失败' + (name ? '：' + name : ''));
    setTimeout(() => {
      item.remove();
      const panel = document.getElementById('upload-panel');
      if (panel && !panel.querySelector('.upload-item')) panel.classList.add('hidden');
    }, 2500);
  },

  _isFileDrag(e) {
    const dt = e.dataTransfer;
    if (!dt || !dt.types) return false;
    try { return Array.from(dt.types).indexOf('Files') >= 0; } catch (err) { return true; }
  },

  // ---------- 全局拖拽上传(无需打开 SFTP 面板) ----------
  bindGlobalDragUpload() {
    document.addEventListener('dragover', (e) => {
      if (!this._isFileDrag(e)) return;
      e.preventDefault(); // 必须,否则浏览器默认阻止 drop
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
    document.addEventListener('drop', (e) => {
      if (!this._isFileDrag(e)) return;
      e.preventDefault();
      // SFTP 面板内的拖拽已由面板自行处理(stopPropagation),这里只兜底面板外
      if (e.target.closest('.sftp-wrap')) return;
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) this._globalUpload(files);
    });
  },

  // 拖拽到窗口(未开 SFTP 面板)时,对当前激活会话做后台上传,目标为远程主目录(~)
  async _globalUpload(fileList) {
    const tab = this.tabs.find(t => t.id === this.activeTabId);
    if (!tab || !tab.session) { this._toast('请先连接一个 SSH 会话再拖拽上传'); return; }
    const s = tab.session;
    if (!s.id) { this._toast('快速连接会话不支持上传,请先保存为会话'); return; }
    let override = null;
    if ((s.protocol || 'ssh') === 'ssh' && !s.hasPassword && s.authType !== 'key') {
      const pw = await this._prompt(`请输入 ${s.username}@${s.host} 的密码:`, { password: true, title: '密码认证' });
      if (pw === null || pw === '') return;
      override = { password: pw };
    }
    const pane = await this._getGhostPane(s, override);
    if (pane) pane._uploadFiles(fileList);
  },

  // 获取一个可用的 SFTP 连接:优先复用该会话已打开的面板,否则建立隐藏连接(单例)
  async _getGhostPane(s, override) {
    const open = this.tabs.find(t => t.sftp && t.sftp.ws && t.sftp.ws.readyState === 1 && t.session && t.session.id === s.id);
    if (open) return open.sftp;
    if (this._ghostPane && this._ghostPane.sessionId === s.id && this._ghostPane.ws && this._ghostPane.ws.readyState === 1) {
      return this._ghostPane;
    }
    if (this._ghostPane) { try { this._ghostPane.close(); } catch (e) {} this._ghostPane = null; }
    const wrap = document.createElement('div');
    wrap.style.display = 'none';
    document.body.appendChild(wrap);
    const pane = new SftpPane(wrap, s.id, override);
    pane.sessionId = s.id;
    try {
      await pane.connect();
      this._ghostPane = pane;
      return pane;
    } catch (e) {
      this._toast('SFTP 连接失败: ' + e.message);
      wrap.remove();
      return null;
    }
  },

  // ---------- 工具 ----------
  showModal(id) { document.getElementById(id).classList.remove('hidden'); },
  closeModal(id) { document.getElementById(id).classList.add('hidden'); },
  esc(s) { const d = document.createElement('div'); d.textContent = String(s == null ? '' : s); return d.innerHTML; },
  fmtSize(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; },

  // ---------- 右键菜单 ----------
  showCtxMenu(items, x, y) {
    const menu = document.getElementById('ctx-menu');
    menu.innerHTML = '';
    for (const it of items) {
      if (it.sep) { const s = document.createElement('div'); s.className = 'ctx-sep'; menu.appendChild(s); continue; }
      const el = document.createElement('div');
      el.className = 'ctx-item' + (it.disabled ? ' disabled' : '');
      el.innerHTML = `<span>${this.esc(it.label)}</span>${it.kbd ? `<span class="kbd">${this.esc(it.kbd)}</span>` : ''}`;
      if (!it.disabled) el.onclick = () => { this.hideCtxMenu(); it.onClick(); };
      menu.appendChild(el);
    }
    menu.classList.remove('hidden');
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    menu.style.left = Math.max(4, Math.min(x, window.innerWidth - mw - 8)) + 'px';
    menu.style.top = Math.max(4, Math.min(y, window.innerHeight - mh - 8)) + 'px';
  },
  hideCtxMenu() { document.getElementById('ctx-menu').classList.add('hidden'); },

  showTerminalCtxMenu(term, x, y) {
    const hasSel = !!term.term.getSelection();
    this.showCtxMenu([
      { label: '复制', kbd: 'Ctrl+Shift+C', disabled: !hasSel, onClick: () => term.copy() },
      { label: '粘贴', kbd: 'Ctrl+Shift+V', onClick: async () => { const t = await navigator.clipboard.readText().catch(() => ''); if (t) term.paste(t); } },
      { label: '一键发送命令', onClick: () => this.showSendCommand() },
      { sep: true },
      { label: '清屏', kbd: 'Ctrl+L', onClick: () => { term.term.clear(); } },
      { label: '全选', onClick: () => { term.term.selectAll(); } }
    ], x, y);
  },

  // 打开一键发送命令弹窗,预填剪贴板内容方便直接发送刚复制的多行命令
  showSendCommand() {
    this.showModal('modal-send');
    const ta = document.getElementById('send-input');
    navigator.clipboard.readText().then(t => { if (t) ta.value = t; }).catch(() => {});
    setTimeout(() => ta.focus(), 60);
  },

  // 发送命令:读取输入框内容,交给当前终端(单行回车执行、多行自动补 \ 续行)
  doSendCommand() {
    const ta = document.getElementById('send-input');
    const text = ta.value || '';
    if (!text.trim()) { this._toast('命令内容为空'); return; }
    const tab = this.tabs.find(t => t.id === this.activeTabId);
    if (!tab || !tab.terminal || tab.terminal.state !== 'ready') { this._toast('请先连接一个终端会话'); return; }
    tab.terminal.sendCommand(text);
    this.closeModal('modal-send');
  },

  showTabCtxMenu(tabId, x, y) {
    const tab = this.tabs.find(t => t.id === tabId);
    const isSel = this.selectedTabIds.has(tabId);
    const selCount = this.selectedTabIds.size;
    this.showCtxMenu([
      { label: isSel ? '移出广播组' : '加入广播组', onClick: () => this.toggleTabSelect(tabId) },
      { label: '广播输入', kbd: 'Ctrl+点击多选', onClick: () => { if (!this.broadcastOn) this.toggleBroadcast(); } },
      { sep: true },
      { label: '布局: 单标签', kbd: this.layoutMode === 'tab' ? '✓' : '', onClick: () => this.setLayout('tab') },
      { label: '布局: 水平排列', kbd: this.layoutMode === 'hsplit' ? '✓' : '', onClick: () => this.setLayout('hsplit') },
      { label: '布局: 垂直排列', kbd: this.layoutMode === 'vsplit' ? '✓' : '', onClick: () => this.setLayout('vsplit') },
      { sep: true },
      { label: '重连', disabled: !(tab && tab.terminal), onClick: () => { this.activateTab(tabId); this.reconnectActive(); } },
      { label: '关闭', onClick: () => this.closeTab(tabId) },
      { label: '关闭其他', onClick: () => { const ids = this.tabs.filter(t => t.id !== tabId).map(t => t.id); ids.forEach(id => this.closeTab(id)); } },
      { label: `关闭广播组(${selCount || 1} 个)`, disabled: !selCount, onClick: () => { const ids = [...this.selectedTabIds]; ids.forEach(id => this.closeTab(id)); } }
    ], x, y);
  },

  showSessionCtxMenu(sessionId, x, y) {
    const selCount = this.selectedSessionIds.size;
    this.showCtxMenu([
      { label: '连接', onClick: () => this.connectSession(sessionId) },
      { label: '编辑', onClick: () => this.editSession(sessionId) },
      { sep: true },
      { label: `批量连接选中会话并开启广播(${selCount} 个)`, disabled: selCount < 2, onClick: () => this.connectSelectedSessions() },
      { label: '删除', onClick: () => this.deleteSession(sessionId) }
    ], x, y);
  },

  async connectSelectedSessions() {
    const ids = [...this.selectedSessionIds];
    if (ids.length < 2) { this._toast('请先 Ctrl+点击多选至少 2 个会话'); return; }
    const tasks = [];
    for (const id of ids) {
      const s = this.sessions.find(x => x.id === id);
      if (!s) continue;
      let override = null;
      if (!s.hasPassword && s.authType !== 'key' && (s.protocol || 'ssh') === 'ssh') {
        const pw = await this._prompt(`请输入 ${s.username}@${s.host} 的密码:`, { password: true, title: '密码认证' });
        if (pw === null || pw === '') continue;
        override = { password: pw };
      }
      tasks.push(this.openTerminalForSession(id, s, override)); // 并行连接
    }
    await Promise.all(tasks);
    // 选中所有新标签并开启广播
    this.selectedTabIds = new Set(this.tabs.map(t => t.id));
    this.renderTabs();
    if (!this.broadcastOn) this.toggleBroadcast();
    else this.updateBroadcastTargets();
  },

  bindEvents() {
    document.getElementById('btn-connect').onclick = () => this.reconnectActive();
    document.getElementById('btn-disconnect').onclick = () => this.disconnectActive();
    document.getElementById('btn-new-session').onclick = () => this.newSession();
    document.getElementById('btn-edit-session').onclick = () => {
      const tab = this.tabs.find(t => t.id === this.activeTabId);
      if (tab && tab.session && tab.session.id) this.editSession(tab.session.id);
      else this._toast('当前标签无关联会话');
    };
    document.getElementById('btn-sftp').onclick = () => this.openSftp();
    document.getElementById('btn-tunnel').onclick = () => this.openTunnel();
    document.getElementById('btn-settings').onclick = () => this.openSettings();
    document.getElementById('btn-monitor').onclick = () => this.toggleMonitor();
    document.getElementById('btn-monitor-close').onclick = () => this.toggleMonitor();
    document.getElementById('btn-manage-keys').onclick = () => this.openKeys();
    document.getElementById('btn-broadcast').onclick = () => this.toggleBroadcast();
    document.getElementById('btn-layout').onclick = (e) => {
      e.stopPropagation(); // 阻止冒泡到 document 的全局 click,避免菜单弹出即被关闭
      const r = e.currentTarget.getBoundingClientRect();
      this.showLayoutMenu(r.left, r.bottom + 4);
    };
    document.getElementById('f-authType').onchange = () => this.toggleAuthFields();
    document.getElementById('f-protocol').onchange = () => this.toggleProtocolFields();
    document.getElementById('btn-clear-password').onclick = () => {
      this._clearPassword = true;
      document.getElementById('f-password').value = '';
      document.getElementById('f-password').placeholder = '保存后将清除已保存密码';
    };
    document.getElementById('q-protocol').onchange = () => {
      const defaults = { ssh: 22, telnet: 23, rlogin: 513 };
      const p = document.getElementById('q-protocol').value;
      const cur = parseInt(document.getElementById('q-port').value, 10) || 0;
      if (!cur || [22, 23, 513].includes(cur)) document.getElementById('q-port').value = defaults[p];
    };
    document.getElementById('btn-add-folder').onclick = async () => {
      // 「新建分组」:输入分组名后,在该分组下新建会话(分组在保存会话时随 group 字段落库)
      const name = await this._prompt('分组名称:', { title: '新建分组', defaultValue: '' });
      if (name === null) return;
      const g = (name || '').trim();
      if (!g) { this._toast('分组名称不能为空'); return; }
      this.newSession(g);
    };
    document.getElementById('session-search').oninput = () => this.renderTree();

    // 日志入口
    document.getElementById('btn-logs') && (document.getElementById('btn-logs').onclick = () => this.openLogs());

    // 右键菜单:点击任意处/非终端与非标签处右键时关闭
    document.addEventListener('click', () => this.hideCtxMenu());
    document.addEventListener('contextmenu', (e) => {
      if (!e.target.closest('.xterm') && !e.target.closest('.tab')) this.hideCtxMenu();
    });

    // 弹窗关闭
    document.querySelectorAll('.modal-close').forEach(b => b.onclick = () => this.closeModal(b.closest('.modal').id));
    document.querySelectorAll('.modal').forEach(m => m.addEventListener('click', (e) => {
      if (e.target !== m) return;
      if (m.id === 'modal-confirm') this._confirmResolve(false);
      else if (m.id === 'modal-prompt') this._promptResolve(null);
      else this.closeModal(m.id);
    }));

    // 弹窗内标签切换
    document.querySelectorAll('.tabs .tab').forEach(t => t.onclick = () => {
      const box = t.closest('.modal-box');
      box.querySelectorAll('.tabs .tab').forEach(x => x.classList.toggle('active', x === t));
      box.querySelectorAll('.tab-page').forEach(p => p.classList.remove('active'));
      const page = box.querySelector('#tab-' + t.dataset.tab);
      if (page) page.classList.add('active');
    });

    // 全局快捷键(复制/粘贴)
    window.addEventListener('keydown', (e) => {
      // 发送命令弹窗打开时,Ctrl+Enter 快捷发送
      if (e.ctrlKey && e.key === 'Enter') {
        const sendModal = document.getElementById('modal-send');
        if (sendModal && !sendModal.classList.contains('hidden')) {
          e.preventDefault();
          this.doSendCommand();
          return;
        }
      }
      const tab = this.tabs.find(t => t.id === this.activeTabId);
      if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
        if (tab && tab.terminal) tab.terminal.copy();
      } else if (e.ctrlKey && e.shiftKey && (e.key === 'V' || e.key === 'v')) {
        // 阻止浏览器对 Ctrl+Shift+V 的默认粘贴动作(否则 xterm 的隐藏输入框
        // 还会再触发一次原生 paste 事件,导致粘贴两次),统一走手动 paste
        e.preventDefault();
        if (tab && tab.terminal) navigator.clipboard.readText().then(t => t && tab.terminal.paste(t)).catch(() => {});
      }
    });

    // 全局拖拽上传(无需打开 SFTP 面板即可拖文件上传)
    this.bindGlobalDragUpload();
  }
};

window.App = App;
document.addEventListener('DOMContentLoaded', () => App.init());
