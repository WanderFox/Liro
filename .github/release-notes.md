## Downloads

| File | What it is |
|---|---|
| `Liro-{{VERSION}}-win-x64.exe` | Desktop client for Windows — installer |
| `Liro-{{VERSION}}-portable.exe` | Desktop client for Windows — portable, no installation |
| `Liro-{{VERSION}}-linux-x86_64.AppImage` | Desktop client for Linux (`chmod +x`, needs `libfuse2`) |
| `liro-src.tar.gz` | Server and web UI with install scripts for Linux and Windows |

**New server:** `tar xzf liro-src.tar.gz && cd liro && sudo bash deploy/install.sh`
(Windows: `deploy\windows\install.ps1` in PowerShell as administrator).

**Update an existing server:** `tar xzf liro-src.tar.gz && cd liro && sudo bash deploy/update.sh`
(Windows: `deploy\windows\update.ps1`). Boards, settings and the service are kept.

The installers are not code-signed: Windows SmartScreen may ask for confirmation on the first start.
