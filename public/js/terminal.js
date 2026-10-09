// terminal.js — 单个终端会话(xterm + WebSocket)
class TerminalSession {
  constructor(container, opts = {}) {
    this.container = container;
    this.opts = opts;
    this.ws = null;
    this.term = null;
    this.connId = null;
    this.state = 'idle';
    this.onState = opts.onState || (() => {});
    this.broadcastTo = []; // 广播目标(其他 TerminalSession)
    this._initXterm();
  }

  _theme() {
    const t = this._resolvedTheme();
    if (t === 'light') {
      return {
        background: '#ffffff', foreground: '#1f2328', cursor: '#0969da',
        selectionBackground: 'rgba(9,105,218,0.2)',
        black: '#1f2328', red: '#cf222e', green: '#116329', yellow: '#9a6700',
        blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#e6e6e6',
        brightBlack: '#656d76', brightRed: '#a40e26', brightGreen: '#1a7f37',
        brightYellow: '#bf8700', brightBlue: '#218bff', brightMagenta: '#a371f7',
        brightCyan: '#3192a3', brightWhite: '#ffffff'
      };
    }
    if (t === 'dark') {
      return {
        background: '#141518', foreground: '#d4d4d4', cursor: '#2f81f7',
        selectionBackground: 'rgba(47,129,247,0.35)',
        black: '#141518', red: '#f47067', green: '#57ab5a', yellow: '#e3b341',
        blue: '#539bf5', magenta: '#b083f0', cyan: '#39c5cf', white: '#c9d1d9',
        brightBlack: '#6e7681', brightRed: '#ff7b72', brightGreen: '#3fb950',
        brightYellow: '#eac54f', brightBlue: '#79c0ff', brightMagenta: '#bc8cff',
        brightCyan: '#56d4dd', brightWhite: '#ffffff'
      };
    }
    // 深蓝(默认)
    return {
      background: '#0b1622', foreground: '#d6e4f0', cursor: '#3b9eff',
      selectionBackground: 'rgba(59,158,255,0.32)',
      black: '#0b1622', red: '#ff6b6b', green: '#4ad184', yellow: '#e6c07b',
      blue: '#5ca8ff', magenta: '#c792ea', cyan: '#4fd6e0', white: '#cfe3f5',
      brightBlack: '#4a6b85', brightRed: '#ff8f8f', brightGreen: '#6fdf9c',
      brightYellow: '#f0d29a', brightBlue: '#82bdff', brightMagenta: '#ddb3f4',
      brightCyan: '#7ce4ec', brightWhite: '#ffffff'
    };
  }

  _resolvedTheme() {
    let t = (window.App && App.settings.theme) || 'dark-blue';
    if (t === 'system') {
      t = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    return t;
  }

  _initXterm() {
    const fs = (window.App && App.settings.fontSize) || 14;
    const ff = (window.App && App.settings.fontFamily) || 'Consolas, "Courier New", monospace';
    this.term = new Terminal({
      fontSize: fs,
      fontFamily: ff,
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: 5000,
      theme: this._theme(),
      allowProposedApi: true
    });
    this.fit = new FitAddon.FitAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new WebLinksAddon.WebLinksAddon());
    this.search = new SearchAddon.SearchAddon();
    this.term.loadAddon(this.search);
    this.term.open(this.container);
    this._applyViewportBg();
    this._preciseFit();

    // 输入 -> 服务端(支持广播)
    this.term.onData((data) => this._input(data));

    // 尺寸变化
    this.term.onResize(({ cols, rows }) => {
      if (this.ws && this.ws.readyState === 1) {
        this.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    });

    const ro = new ResizeObserver(() => this._preciseFit());
    ro.observe(this.container);
    this._ro = ro;

    // 右键:弹出菜单(复制/粘贴/清屏/全选)
    this.container.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (window.App && App.showTerminalCtxMenu) App.showTerminalCtxMenu(this, e.clientX, e.clientY);
    });

    // 拦截原生粘贴(Ctrl+V / Shift+Insert 等),统一走 paste() 的多行命令处理
    // (2 行以上自动补 \ 续行并回车执行),避免绕过 paste() 导致多行命令未被处理。
    // 捕获阶段 stopPropagation,阻止 xterm 内部 textarea 再处理一次。
    this.container.addEventListener('paste', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const text = (e.clipboardData && e.clipboardData.getData('text')) || '';
      if (text) this.paste(text);
    }, true);
  }

  // 精确 fit:用 clientWidth/clientHeight(明确含 padding、不含 border)扣除 padding 得内容区,
  // 再向下取整算行列。避免 FitAddon 用 getComputedStyle().height 在 box-sizing:border-box 下
  // 把 padding 也算进可用高度,导致窗口缩小时多算一行、最后一行被裁剪。
  _preciseFit() {
    const el = this.container;
    if (!el || !this.term) return;
    // 容器不可见(如标签切到后台 display:none)时跳过:
    // 否则 clientWidth=0 会把终端 resize 成极窄列,远程 PTY 跟着变窄,
    // 之后输出的提示符/命令被逐字符折行成乱码,且已写入缓冲的内容无法恢复
    if (!el.isConnected || el.clientWidth === 0 || el.clientHeight === 0) return;
    const cs = window.getComputedStyle(el);
    const padTop = parseFloat(cs.paddingTop) || 0;
    const padBottom = parseFloat(cs.paddingBottom) || 0;
    const padLeft = parseFloat(cs.paddingLeft) || 0;
    const padRight = parseFloat(cs.paddingRight) || 0;
    const availW = Math.max(0, el.clientWidth - padLeft - padRight);
    const availH = Math.max(0, el.clientHeight - padTop - padBottom);
    const core = this.term._core;
    const dims = core && core._renderService && core._renderService.dimensions;
    if (!dims || !dims.css.cell.width || !dims.css.cell.height) {
      // cell 尺寸未就绪时回退到 FitAddon
      try { this.fit.fit(); } catch (e) {}
      return;
    }
    const cols = Math.max(2, Math.floor(availW / dims.css.cell.width));
    const rows = Math.max(1, Math.floor(availH / dims.css.cell.height));
    if (this.term.cols !== cols || this.term.rows !== rows) {
      this.term.resize(cols, rows);
    }
  }

  // 让 xterm 视口(viewport)背景跟随主题背景色,消除底部未被画布铺满时露出的黑色 #000 边
  _applyViewportBg() {
    const vp = this.container && this.container.querySelector('.xterm-viewport');
    if (vp) vp.style.backgroundColor = this._theme().background;
  }

  // 发送输入(自身 + 广播目标)
  _input(data) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify({ type: 'input', data }));
    }
    if (this.broadcastTo && this.broadcastTo.length) {
      for (const t of this.broadcastTo) {
        if (t && t !== this && t.ws && t.ws.readyState === 1) {
          t.ws.send(JSON.stringify({ type: 'input', data }));
        }
      }
    }
  }

  connect(sessionId, override) {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws/terminal`);
      this.ws = ws;
      this.state = 'connecting';
      this.onState('connecting');

      ws.onopen = () => {
        const payload = sessionId ? { type: 'connect', sessionId, override } : { type: 'connect', session: override };
        // 带上当前终端实际尺寸,让远程 PTY 按实际大小打开,
        // 避免默认 80x24 导致 vi/vim 等全屏程序只占一小块、内容不占满
        payload.cols = this.term.cols;
        payload.rows = this.term.rows;
        ws.send(JSON.stringify(payload));
      };
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.type === 'data') {
          this.term.write(m.data);
        } else if (m.type === 'ready') {
          this.connId = m.connId;
          this.state = 'ready';
          this.onState('ready');
          resolve();
          // 连接建立后主动同步一次尺寸:连接前 fit 过时 term 尺寸可能未变化,
          // 不会触发 onResize 发送 resize,导致远程 PTY 停在默认 80x24
          this._syncSize();
        } else if (m.type === 'error') {
          this.term.write('\r\n\x1b[31m[错误] ' + m.message + '\x1b[0m\r\n');
          reject(new Error(m.message));
        } else if (m.type === 'close') {
          this.state = 'closed';
          this.onState('closed');
          if (m.reason && m.reason !== 'user-disconnect') {
            this.term.write('\r\n\x1b[33m[连接已断开: ' + m.reason + ']\x1b[0m\r\n');
          }
        }
      };
      ws.onerror = () => { this.term.write('\r\n\x1b[31m[WebSocket 连接失败]\x1b[0m\r\n'); };
      ws.onclose = () => {
        if (this.state !== 'closed') { this.state = 'closed'; this.onState('closed'); }
      };
    });
  }

  disconnect() {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify({ type: 'disconnect' }));
    }
    this.state = 'closed';
    this.onState('closed');
  }

  // 主动把当前终端尺寸同步给远程 PTY(连接建立后/尺寸可能未变时使用)
  _syncSize() {
    if (this.ws && this.ws.readyState === 1 && this.term) {
      this.ws.send(JSON.stringify({ type: 'resize', cols: this.term.cols, rows: this.term.rows }));
    }
  }

  paste(text) {
    // 原样保留换行粘贴,不补 \、不删除换行:shell 会根据换行自然区分
    // 多条独立命令(换行逐条执行)与带 \ 续行的一条多行命令(续行拼接)。
    const payload = this._normalizeText(text);
    if (this.ws && this.ws.readyState === 1) {
      this._input(payload);
    } else {
      this.term.paste(payload);
    }
    // 粘贴后把焦点还给终端,便于直接回车继续输入(否则焦点停在按钮/页面上)
    this.focus();
  }

  // 一键发送命令:一次发送多条命令,逐条执行(保留换行,末尾追加回车确保执行)
  sendCommand(text) {
    const payload = this._normalizeText(text);
    if (!payload) return;
    if (this.ws && this.ws.readyState === 1) {
      this._input(payload + '\r');
    } else {
      this.term.paste(payload + '\r');
    }
    this.focus();
  }

  // 归一化换行:只统一 \r\n / \r 为 \n,不补 \ 续行符、不删除换行
  _normalizeText(text) {
    if (typeof text !== 'string' || text === '') return text || '';
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }

  copy() {
    const sel = this.term.getSelection();
    if (sel) navigator.clipboard.writeText(sel).catch(() => {});
    return sel;
  }

  focus() { this.term.focus(); }
  refit() { this._preciseFit(); }
  reloadTheme() { this.term.options.theme = this._theme(); this.term.options.fontSize = (window.App && App.settings.fontSize) || 14; this.term.options.fontFamily = (window.App && App.settings.fontFamily) || 'monospace'; this._applyViewportBg(); this._preciseFit(); }
  destroy() {
    try { this._ro.disconnect(); } catch (e) {}
    this.disconnect();
    this.term.dispose();
  }
}
