<div align="center">

<img src="docs/logo.png" width="96" alt="Liro 标志">

# Liro

**为局域网打造的自托管协作白板。**
灵感来自 Miro 和 Milanote —— 但白板保存在你自己的服务器上，可离线使用，无需注册账号。

[English](README.md) · [Русский](README.ru.md) · **中文**

![License: GPL v3](https://img.shields.io/badge/license-GPL--3.0-4262ff)
![Server: Linux | Windows](https://img.shields.io/badge/server-Linux%20%7C%20Windows-2b2b35)
![Clients: Windows | Linux AppImage | Browser](https://img.shields.io/badge/clients-Windows%20%7C%20Linux%20AppImage%20%7C%20Browser-2b2b35)
![Node.js 18+](https://img.shields.io/badge/node-%E2%89%A518-8fd14f)

<img src="docs/screenshots/board.png" alt="Liro 白板：流程图、便签、任务清单、表格、链接卡片、嵌套白板和 3D 模型" width="100%">

</div>

## 为什么选择 Liro

- **你的网络，你的数据。** 只需一个运行在 Linux 或 Windows 上的小型 Node.js 服务器；白板和文件就是服务器磁盘上的普通文件夹。
- **实时协作。** 局域网内的每个人都可以编辑同一块白板，并看到彼此的光标和选中内容。
- **离线优先。** 把白板缓存到本机，服务器关闭时也能继续工作；服务器恢复后，Liro 会询问如何合并修改。
- **无需账号、无云端、无追踪。** 打开应用，选择在网络中找到的服务器，即可开始。

## 功能

| | |
|---|---|
| 🗒️ **内容** | 便签、支持项目符号与编号列表的文本、48 种图形（基础、流程图、标注）以及自定义 SVG 图形、带标签并可连接图形的线条和箭头（直线、折线、曲线）、带平滑的画笔、框架 |
| ✅ **结构** | 可拖放排序并显示进度的多级任务清单、表格、任意年份的年历、带讨论串的评论、带文件夹图标和导航路径的嵌套白板 |
| 🖼️ **媒体** | 图片、视频、音频、任意文件、带预览的链接卡片（预览图缓存在服务器上）、贴纸包、可旋转查看的 3D 模型（glTF/GLB、FBX、OBJ+MTL、STL、PLY、3MF、DAE） |
| 🎨 **样式** | 色轮与自定义预设、填充和线条透明度、虚线设置、23 款内置字体并支持上传自定义字体、智能对齐参考线、对齐与均匀分布 |
| 👥 **协作** | 实时编辑、其他成员的光标和选中内容、并发编辑无冲突合并、撤销与重做 |
| 📴 **离线与本地** | 已缓存的白板无需服务器即可使用；离线时也能新建白板；“本地白板”只保存在你的电脑上，之后可随时迁移到服务器 |
| 🗄️ **管理** | 整个服务器、单个白板或本地白板的备份；磁盘空间限制；未使用的文件 24 小时后清理；适用于 Linux 和 Windows 的安装、更新和存储迁移脚本 |
| 🌍 **语言** | 界面支持英语和俄语（默认跟随系统语言） |

## 截图

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/home.png" alt="服务器和白板"><br><sub><b>服务器和白板。</b> 网络中发现的服务器、本地白板、缓存与备份。</sub></td>
    <td width="50%"><img src="docs/screenshots/shapes.png" alt="图形库"><br><sub><b>图形库。</b> 基础图形、流程图、标注以及自定义 SVG 图形。</sub></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/collaboration.png" alt="评论、任务清单和表格"><br><sub><b>协同工作。</b> 评论讨论、多级清单、表格和实时光标。</sub></td>
    <td><img src="docs/screenshots/model.png" alt="3D 模型查看器"><br><sub><b>3D 模型。</b> 直接在白板上旋转模型，视角会被记住。</sub></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/nested-boards.png" alt="嵌套白板"><br><sub><b>嵌套白板。</b> 白板中的白板，带导航路径。</sub></td>
    <td><img src="docs/screenshots/calendar.png" alt="年历"><br><sub><b>年历。</b> 基于可编辑表格生成任意年份的大日历。</sub></td>
  </tr>
</table>

## 快速开始

### 1. 运行服务器

<details open>
<summary><b>Linux</b>（systemd）</summary>

```bash
tar xzf liro-src.tar.gz && cd liro
sudo bash deploy/install.sh
```

脚本会在需要时安装 Node.js 22，把服务器复制到 `/opt/liro`，白板数据保存在 `/var/lib/liro`，设置保存在
`/etc/liro/liro.env`，并启动 `liro` 服务、开放防火墙端口。

```bash
sudo bash deploy/update.sh                              # 更新到新版本，保留白板和设置
sudo bash deploy/configure.sh --data /mnt/storage/liro  # 迁移白板存储目录
journalctl -u liro -f                                   # 查看日志
```
</details>

<details>
<summary><b>Windows</b>（以管理员身份运行 PowerShell）</summary>

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\install.ps1 -DataDir D:\LiroData
powershell -ExecutionPolicy Bypass -File deploy\windows\update.ps1
powershell -ExecutionPolicy Bypass -File deploy\windows\configure.ps1 -DataDir E:\LiroData
powershell -ExecutionPolicy Bypass -File deploy\windows\uninstall.ps1
```

服务器以计划任务 “Liro Server” 运行（随 Windows 启动，出错时自动重启）。
设置：`C:\ProgramData\Liro\liro.env`，日志：`C:\ProgramData\Liro\logs\liro.log`。
</details>

<details>
<summary><b>免安装运行</b></summary>

```bash
cd server && npm install && npm start
```
</details>

之后即可通过 `http://<服务器IP>:1919` 访问白板 —— 在任意浏览器或桌面客户端中均可。

### 2. 安装客户端

从 [Releases](../../releases/latest) 下载：

| 平台 | 文件 |
|---|---|
| Windows（安装版） | `Liro-<版本>-win-x64.exe` |
| Windows（便携版） | `Liro-<版本>-portable.exe` |
| Linux | `Liro-<版本>-linux-x86_64.AppImage`（`chmod +x`，需要 `libfuse2`） |

客户端会自动发现网络中的 Liro 服务器（UDP 广播和 mDNS），也可以按地址连接：
`liro.loc`、`192.168.1.10` 或 `192.168.1.10:1919`。

### 3. 可选：`liro.loc` 域名

客户端不需要它，但浏览器需要。可以在路由器上添加 DNS 记录 `liro.loc → <服务器IP>`
（dnsmasq：`server=/loc/<服务器IP>`，并开启内置 DNS 应答 `LIRO_DNS=1`），或在每台电脑的 `hosts`
文件中加入 `<服务器IP> liro.loc`。

## 离线使用

- 为白板勾选 **缓存（Cache）**：白板及其所有文件会保存在本机，并与服务器保持同步。
- 服务器不可用时，已缓存的白板仍可完整编辑。你的修改会排队保存在磁盘上（重启后也不会丢失）。
- 服务器恢复后，Liro 会询问：**更新服务器上的白板**、**把你的版本另存为副本**，或 **放弃你的修改**。
- 服务器离线时也可以新建白板，服务器恢复后会自动上传。
- **本地白板** 只保存在你的电脑（或浏览器）中，之后可以随时迁移到任意服务器。

## 备份

**备份（Backup）** 按钮出现在三个位置：

| 位置 | 保存内容 | 恢复到 |
|---|---|---|
| 服务器的白板列表 | 所有白板及文件、上传的字体、图形、图标和贴纸包 | 该服务器 |
| “本地白板” | 所有本地白板、本地字体/图形/图标以及客户端设置 | 本地白板 |
| 打开的白板 | 当前白板及其嵌套白板和文件 | 白板所在的位置 |

备份是普通的 `.tar` 归档，文件名表明其内容（`Liro-server-…`、`Liro-board-…`、`Liro-local-…`），
内含 `manifest.json`。恢复时可以选择替换已有的白板和文件，或只添加缺少的内容。

## 配置

服务器设置为环境变量，通常写在 `liro.env` 中：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `LIRO_NAME` | `Liro (<主机名>)` | 客户端中显示的服务器名称 |
| `LIRO_PORT` | `1919` | HTTP/WebSocket 端口（UDP 发现使用相同端口号） |
| `LIRO_EXTRA_PORTS` | — | 额外的 HTTP 端口，例如 `80`，用于 `http://liro.loc` |
| `LIRO_DATA` | `server/data` | 白板、媒体、字体、图形、图标、贴纸 |
| `LIRO_HOSTNAME` | `liro.loc` | 内置 DNS 应答的域名 |
| `LIRO_DNS` | `0` | 在 53 端口启用内置 DNS 应答 |
| `LIRO_MDNS` | `1` | 通过 mDNS 广播服务器 |
| `LIRO_MAX_UPLOAD_MB` | `2048` | 单个上传文件的最大大小 |
| `LIRO_DISK_WARN_GB` / `LIRO_DISK_BLOCK_GB` | `10` / `5` | 磁盘空间不足警告 / 仅允许编辑 |
| `LIRO_MEDIA_GRACE_HOURS` | `24` | 未使用的文件在多少小时后删除 |
| `LIRO_CONFIG` | `/etc/liro/liro.env`、`%ProgramData%\Liro\liro.env` | 读取的设置文件 |

端口：`1919/tcp`（网页、API）、`1919/udp`（发现）、`5353/udp`（mDNS），可选 `80/tcp` 和 `53/udp`。

**贴纸包：** 把图片文件夹放到 `<数据目录>/stickers/<贴纸包>/`（可选 `pack.json`：`{"name": "…"}`），
无需重启即可在所有客户端中显示。

## 快捷键

| 按键 | 操作 | 按键 | 操作 |
|---|---|---|---|
| `V` | 选择 | `H` / `空格` | 抓手 |
| `N` | 便签 | `T` | 文本 |
| `R` / `O` | 矩形 / 椭圆 | `L` / `A` | 线条 / 箭头 |
| `P` | 画笔 | `E` | 橡皮擦 |
| `K` | 任务清单 | `G` | 表格 |
| `B` | 嵌套白板 | `F` | 框架 |
| `C` | 评论 | `Del` | 删除 |
| `Ctrl+Z` / `Ctrl+Shift+Z` | 撤销 / 重做 | `Ctrl+C` / `V` / `D` | 复制 / 粘贴 / 创建副本 |
| `Shift+1` | 缩放以显示全部 | 拖动时按住 `Alt` | 不吸附参考线 |

## 从源码构建

```bash
cd server && npm install && npm test          # 服务器及 15 个端到端测试
cd client && npm install && npm run dist:win   # Windows 安装版和便携版（在 Windows 上）
cd client && bash build-linux.sh               # Linux AppImage（在 Linux 或 WSL 中）
```

```
server/   Node.js 服务器：HTTP API、WebSocket 同步、存储、发现、备份
web/      浏览器和桌面客户端共用的白板界面
client/   Electron 桌面客户端：服务器发现、本地缓存、离线模式
deploy/   适用于 Linux 和 Windows 的安装、更新和配置脚本
```

## 许可证

Liro 是以 [GNU 通用公共许可证 v3.0](LICENSE) 发布的自由软件。内置的字体、图标、贴纸和库保留各自的许可证 ——
详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

Liro 是一个独立项目，与 Miro 或 Milanote 无关；其名称均为各自所有者的商标。
