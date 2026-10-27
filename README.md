<div align="center">

<img src="docs/logo.png" width="96" alt="Liro logo">

# Liro

**A self-hosted collaborative whiteboard for your local network.**
Inspired by Miro and Milanote — but your boards live on your own server, work offline and need no accounts.

**English** · [Русский](README.ru.md) · [中文](README.zh-CN.md)

![License: MIT](https://img.shields.io/badge/license-MIT-4262ff)
![Server: Linux | Windows](https://img.shields.io/badge/server-Linux%20%7C%20Windows-2b2b35)
![Clients: Windows | Linux AppImage | Browser](https://img.shields.io/badge/clients-Windows%20%7C%20Linux%20AppImage%20%7C%20Browser-2b2b35)
![Node.js 18+](https://img.shields.io/badge/node-%E2%89%A518-8fd14f)

<img src="docs/screenshots/board.png" alt="A Liro board with a flowchart, sticky notes, a checklist, a table, a link card, nested boards and a 3D model" width="100%">

</div>

## Why Liro

- **Your network, your data.** One small Node.js server on Linux or Windows; boards and files are plain folders on its disk.
- **Real-time teamwork.** Everyone on the LAN edits the same board and sees each other's cursors and selections.
- **Offline first.** Cache a board on your computer and keep working when the server is down — Liro asks how to merge when it comes back.
- **No accounts, no cloud, no tracking.** Open the app, pick the server it found on the network, start drawing.

## Features

| | |
|---|---|
| 🗒️ **Content** | Sticky notes, text with bulleted/numbered lists, 48 shapes (basic, flowchart, callouts) and your own SVG shapes, lines and arrows (straight, elbow, curved) with labels and connection to shapes, freehand pen with smoothing, frames |
| ✅ **Structure** | Nested checklists with drag & drop and progress, tables, a year calendar for any year, comments with threads, nested boards with folder icons and breadcrumbs |
| 🖼️ **Media** | Images, video, audio, any files, link cards with previews (cached on the server), sticker packs, 3D models (glTF/GLB, FBX, OBJ+MTL, STL, PLY, 3MF, DAE) with a rotatable viewer |
| 🎨 **Styling** | Colour wheel with saved presets, fill and line opacity, dash settings, 23 bundled fonts plus your own uploads, smart alignment guides, align & distribute |
| 👥 **Collaboration** | Live editing, cursors and selections of other people, conflict-free merging of concurrent edits, undo/redo |
| 📴 **Offline & local** | Cached boards work without the server; create new boards offline; *Local boards* that never leave your computer and can later be moved to a server |
| 🗄️ **Admin** | Backups of the whole server, a single board or your local boards; disk space limits; unused files cleaned up after 24 h; install, update and storage-move scripts for Linux and Windows |
| 🌍 **Languages** | English and Russian interface (follows the system language) |

## Screenshots

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/home.png" alt="Server list and boards"><br><sub><b>Servers and boards.</b> Servers found on the network, local boards, caching and backups.</sub></td>
    <td width="50%"><img src="docs/screenshots/shapes.png" alt="Shape library"><br><sub><b>Shape library.</b> Basic shapes, flowchart, callouts and your own SVG shapes.</sub></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/collaboration.png" alt="Comments, checklist and table"><br><sub><b>Working together.</b> Comment threads, nested checklists, tables and live cursors.</sub></td>
    <td><img src="docs/screenshots/model.png" alt="3D model viewer"><br><sub><b>3D models.</b> Rotate a model right on the board; it remembers the view.</sub></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/nested-boards.png" alt="Nested board"><br><sub><b>Nested boards.</b> Boards inside boards with breadcrumbs.</sub></td>
    <td><img src="docs/screenshots/calendar.png" alt="Year calendar"><br><sub><b>Year calendar.</b> A big calendar for any year, built from an editable table.</sub></td>
  </tr>
</table>

## Getting started

### 1. Run the server

<details open>
<summary><b>Linux</b> (systemd)</summary>

```bash
tar xzf liro-src.tar.gz && cd liro
sudo bash deploy/install.sh
```

Installs Node.js 22 if needed, copies the server to `/opt/liro`, keeps boards in `/var/lib/liro`, settings in
`/etc/liro/liro.env`, starts the `liro` service and opens firewall ports.

```bash
sudo bash deploy/update.sh                           # update to a new version, keeps boards and settings
sudo bash deploy/configure.sh --data /mnt/storage/liro  # move the board storage
journalctl -u liro -f                                # logs
```
</details>

<details>
<summary><b>Windows</b> (PowerShell as administrator)</summary>

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\install.ps1 -DataDir D:\LiroData
powershell -ExecutionPolicy Bypass -File deploy\windows\update.ps1
powershell -ExecutionPolicy Bypass -File deploy\windows\configure.ps1 -DataDir E:\LiroData
powershell -ExecutionPolicy Bypass -File deploy\windows\uninstall.ps1
```

The server runs as the scheduled task *Liro Server* (starts with Windows, restarts on failure).
Settings: `C:\ProgramData\Liro\liro.env`, log: `C:\ProgramData\Liro\logs\liro.log`.
</details>

<details>
<summary><b>Without installing</b></summary>

```bash
cd server && npm install && npm start
```
</details>

The board is now available at `http://<server-ip>:1919` — in any browser, or in the desktop clients.

### 2. Install a client

Download from [Releases](../../releases/latest):

| Platform | File |
|---|---|
| Windows (installer) | `Liro-<version>-win-x64.exe` |
| Windows (portable) | `Liro-<version>-portable.exe` |
| Linux | `Liro-<version>-linux-x86_64.AppImage` (`chmod +x`, needs `libfuse2`) |

The client finds Liro servers on the network automatically (UDP broadcast and mDNS). You can also connect by
address: `liro.loc`, `192.168.1.10` or `192.168.1.10:1919`.

### 3. Optional: the `liro.loc` name

The clients don't need it, but browsers do. Either add a DNS record `liro.loc → <server-ip>` on your router
(dnsmasq: `server=/loc/<server-ip>` with the built-in DNS responder `LIRO_DNS=1`), or add
`<server-ip> liro.loc` to the `hosts` file of each computer.

## Working offline

- Tick **Cache** on a board: the board and all its files are stored on your computer and kept in sync.
- If the server becomes unreachable, a cached board stays fully editable. Your changes are queued on disk (they survive restarts).
- When the server is back, Liro asks: **update the board on the server**, **save your version as a copy**, or **discard your changes**.
- New boards can be created while the server is offline — they are uploaded when it returns.
- **Local boards** live only on your computer (or in your browser) and can be moved to any server later.

## Backups

The **Backup** button exists in three places:

| Where | Saves | Restores into |
|---|---|---|
| Board list of a server | All boards with files, uploaded fonts, shapes, icons and sticker packs | That server |
| *Local boards* | All local boards, local fonts/shapes/icons and client settings | Local boards |
| An open board | This board with its nested boards and files | Where the board is |

Backups are plain `.tar` archives named after what they contain (`Liro-server-…`, `Liro-board-…`, `Liro-local-…`)
with a `manifest.json` inside. When restoring you choose whether to replace existing boards and files or only add missing ones.

## Configuration

Server settings are environment variables, usually set in `liro.env`:

| Variable | Default | Description |
|---|---|---|
| `LIRO_NAME` | `Liro (<hostname>)` | Server name shown in the clients |
| `LIRO_PORT` | `1919` | HTTP/WebSocket port (UDP discovery uses the same number) |
| `LIRO_EXTRA_PORTS` | — | Extra HTTP ports, e.g. `80` for `http://liro.loc` |
| `LIRO_DATA` | `server/data` | Boards, media, fonts, shapes, icons, stickers |
| `LIRO_HOSTNAME` | `liro.loc` | Name answered by the built-in DNS responder |
| `LIRO_DNS` | `0` | Built-in DNS responder on port 53 |
| `LIRO_MDNS` | `1` | Announce the server via mDNS |
| `LIRO_MAX_UPLOAD_MB` | `2048` | Max size of one uploaded file |
| `LIRO_DISK_WARN_GB` / `LIRO_DISK_BLOCK_GB` | `10` / `5` | Warn about low disk space / allow editing only |
| `LIRO_MEDIA_GRACE_HOURS` | `24` | Unused files are deleted after this time |
| `LIRO_CONFIG` | `/etc/liro/liro.env`, `%ProgramData%\Liro\liro.env` | Settings file to read |

Ports: `1919/tcp` (web, API), `1919/udp` (discovery), `5353/udp` (mDNS), optional `80/tcp` and `53/udp`.

**Sticker packs:** drop a folder of images into `<data>/stickers/<pack>/` (optional `pack.json` with `{"name": "…"}`).
They appear in all clients without a restart.

## Keyboard shortcuts

| Key | Action | Key | Action |
|---|---|---|---|
| `V` | Select | `H` / `Space` | Hand |
| `N` | Sticky note | `T` | Text |
| `R` / `O` | Rectangle / Oval | `L` / `A` | Line / Arrow |
| `P` | Pen | `E` | Eraser |
| `K` | Checklist | `G` | Table |
| `B` | Nested board | `F` | Frame |
| `C` | Comment | `Del` | Delete |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / Redo | `Ctrl+C` / `V` / `D` | Copy / Paste / Duplicate |
| `Shift+1` | Zoom to fit | `Alt` while dragging | Move without snapping |

## Building from source

```bash
cd server && npm install && npm test          # server + 15 end-to-end tests
cd client && npm install && npm run dist:win   # Windows installer + portable (on Windows)
cd client && bash build-linux.sh               # Linux AppImage (on Linux or WSL)
```

```
server/   Node.js server: HTTP API, WebSocket sync, storage, discovery, backups
web/      board UI shared by the browser and the desktop client
client/   Electron desktop client: discovery, local cache, offline mode
deploy/   install / update / configure scripts for Linux and Windows
```

## License

Liro is released under the [MIT License](LICENSE). Bundled fonts, icons, stickers and libraries keep their own
licenses — see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Liro is an independent project and is not affiliated with Miro or Milanote; their names are trademarks of their respective owners.
