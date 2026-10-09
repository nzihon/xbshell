# XBTerminal — 远程终端

基于 **Node.js + xterm.js**,支持 SSH / Telnet / Rlogin 终端、SFTP 文件传输、端口转发、多会话广播输入等核心能力,零原生编译、跨平台,可打包为 Windows 桌面 exe。

## 功能清单

| 功能 | 说明 |
|------|------|
| 会话管理 | 新建/编辑/删除会话,支持分组、搜索,持久化到本地 |
| 多协议连接 | SSH(密码/私钥/键盘交互)、Telnet、Rlogin |
| 多标签终端 | 多个会话并行连接、标签切换、256 色终端、自适应尺寸 |
| 广播输入 | Ctrl 多选标签 / 会话,一键同时向多台机器发送命令(运维利器) |
| SFTP 文件传输 | 图形化文件浏览、上传、下载、新建目录、重命名、删除 |
| 端口转发 | 本地转发 / 远程转发 / 动态转发(SOCKS5 代理) |
| 会话日志 | 终端输出落盘记录,可在线查看 |
| 快捷命令 | 每个会话配置一键发送的命令 |
| 多主题 | 深蓝(默认)/ 白 / 黑 / 跟随系统,终端配色联动 |
| 右键菜单 | 终端右键(复制/粘贴/清屏/全选)、标签右键(关闭/重连/广播组) |
| 密钥管理 | 私钥导入/删除 |
| 密码安全 | 密码使用 AES-256-CBC 加密存储,密钥仅存本机 |

## 目录结构

```
xbshell/
├── server.js            # 主服务(Express + WebSocket),可独立运行或被 Electron 内嵌
├── electron/main.js     # Electron 主进程(内嵌启动服务 + 桌面窗口)
├── lib/
│   ├── store.js         # 会话持久化 + 密码加密 + 密钥/日志管理(数据目录可配置)
│   ├── ssh.js           # SSH 连接管理器(按协议分发)
│   ├── telnet.js        # Telnet / Rlogin 连接(RFC854 协商 + 窗口大小)
│   ├── tunnel.js        # 端口转发(本地/远程/动态 SOCKS5)
├── public/
│   ├── index.html       # 主界面
│   ├── css/style.css    # 多主题变量
│   ├── js/              # api/terminal/sftp/app
│   └── vendor/          # xterm.js 及插件
├── tools/gen-icon.js    # 应用图标生成脚本
├── build/icon.png       # 打包用图标
└── config/              # 运行时生成(会话/密钥/日志)
```

## 快速开始

```bash
cd xbshell
npm install
npm start
# 浏览器打开 http://127.0.0.1:8080
```

Windows 下也可直接双击 `start.bat`。

## 桌面端打包(EXE)

```bash
npm install                     # 安装依赖
npm run dist                    # 打包 Windows 安装包 + 单文件便携版
```

产物在 `dist/` 目录:

| 文件 | 说明 |
|------|------|
| `XBTerminal-1.0.0-portable.exe` | 单文件便携版,双击即用(推荐) |
| `XBTerminal-1.0.0-x64.exe`      | NSIS 安装包,可自定义安装目录、创建桌面快捷方式 |

桌面版特性:

- 独立窗口运行,无需浏览器
- 数据(会话/密钥/日志)保存在用户目录 `%APPDATA%\xbterminal\`
- 可通过环境变量 `XTERMINAL_PORT` 固定内嵌服务端口(默认随机)
- 首次打包较慢(需下载 Electron 与打包工具),可用国内镜像加速:
  ```bash
  export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
  ```

## 使用说明

1. **新建会话**:点「新建会话」,选择协议(SSH/Telnet/Rlogin),填主机/端口/用户名。SSH 在「认证」页选择密码或私钥;Telnet/Rlogin 为终端内交互式登录。
2. **连接**:双击左侧会话,或在会话上点 ▶。SSH 未保存密码时会弹窗输入。
3. **广播输入**:Ctrl+点击多个标签(或会话)多选,再点顶栏「📡 广播」开启;此后在任一选中终端输入,会同步发送到所有选中会话。也可在会话树 Ctrl 多选后右键「批量连接并开启广播」。
4. **复制/粘贴**:终端内右键弹出菜单(复制/粘贴/清屏/全选),或使用 Ctrl+Shift+C / Ctrl+Shift+V。
5. **SFTP**:连接后点顶栏「SFTP」,双击目录进入、单击文件下载、右键重命名/删除。
6. **隧道**:点「隧道」,选择会话与转发类型,填端口后启动。动态转发可作为系统 SOCKS5 代理。
7. **日志**:会话属性勾选「记录会话日志」后,输出会写入本地,可在「日志」中查看。
8. **主题**:「设置」中选择深蓝/白/黑/跟随系统。

## 架构说明

```
浏览器(xterm.js + 前端 UI)
      │  WebSocket /ws/terminal(终端)、/ws/sftp(文件)
      ▼
Node.js 服务端(Express + ws)
      │  ConnectionManager 按 protocol 分发
      ├─ ssh2 库          → SSH
      ├─ net + RFC854     → Telnet / Rlogin
      └─ ssh2 forward     → 端口转发
```

- 每个终端标签 = 一条独立 WebSocket + 一条独立连接,互不干扰。
- 会话配置集中在后端解析,密码解密只在服务端进行,前端不持有明文。
- 广播输入在前端实现:一个终端的输入会同步转发到其他选中终端各自的 WebSocket。

## 安全提示

- 密码加密密钥存放于本机(首次运行自动生成),仅本机可解密,请勿复制到其他机器。
- 本应用默认监听 `127.0.0.1`,请勿直接暴露到公网;如需远程访问,请自行添加 HTTPS 与访问控制。
- Telnet/Rlogin 为明文协议,请仅在可信内网使用。

## 后续可扩展

- Serial 串口协议(需原生模块)
- X11 转发、ZMODEM 传输
- 会话分组拖拽、批量操作
- 自动更新、多语言、代码签名
