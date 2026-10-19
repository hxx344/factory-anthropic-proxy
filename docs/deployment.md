# 启动与升级

运行需要 Node.js 22 或更新版本。代理没有运行时第三方依赖，无需执行 `npm install`。默认只监听 `127.0.0.1:8787`；代理自己的 `proxyKey` 与 Factory 的凭据分开保存。

## Windows

从正式发布页下载 `factory-anthropic-proxy-<版本>.tgz`，使用 Windows 自带的 `tar -xzf` 解压，进入 `package` 文件夹，双击 `start.cmd`。也可在源码目录双击同一个文件。启动器复用系统 Node.js 22+；缺少时下载固定的 Node.js 24.15.0 Windows x64 官方压缩包，验证官方 SHA256 校验值并缓存到 `.local/runtime`，后续启动复用缓存。

首次启动会创建 `proxy.config.json` 并生成随机代理密钥；已有配置不会被覆盖。代理以前台方式运行，按 Ctrl+C 或关闭窗口停止本次启动的代理。启动器不会停止其他进程；端口被占用时会显示错误。

如需指定配置，在 PowerShell 运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start.ps1 -Config D:\private\proxy.config.json
```

升级时将新版本解压到原目录，保留 `proxy.config.json`、`.local` 和自己的其他文件，再重新启动。请勿将这些本地文件上传到 GitHub 或包含在分发包中。

## Linux 一键安装

安装器使用 systemd，将程序装到 `/opt/factory-anthropic-proxy`，配置保存在 `/etc/factory-anthropic-proxy/proxy.config.json`，环境变量保存在该目录的 `environment`，文件权限为 `0600`。服务使用独立的 `factory-anthropic-proxy` 系统用户。

先在当前终端设置 `FACTORY_API_KEY`，然后运行下面一条命令安装或升级正式版：

```bash
curl -fsSL https://github.com/hxx344/factory-anthropic-proxy/releases/latest/download/install.sh | sudo --preserve-env=FACTORY_API_KEY,PROXY_API_KEY bash
```

安装器从正式发布页读取 `SHA256SUMS`，仅在目标版本内容尚未安装时下载源码包并验证 SHA256。系统中已有 Node.js 22+ 时复用；缺少时下载并验证固定的 Node.js 24.15.0 Linux x64 或 arm64 私有运行时。首次安装只在缺少系统工具时安装所需依赖。

如从已下载、解压的源码安装：

```bash
sudo --preserve-env=FACTORY_API_KEY,PROXY_API_KEY bash scripts/install.sh
```

也可安装本地正式发布包，或锁定指定版本：

```bash
sudo --preserve-env=FACTORY_API_KEY,PROXY_API_KEY bash scripts/install.sh --source ./factory-anthropic-proxy-0.1.0.tgz
curl -fsSL https://github.com/hxx344/factory-anthropic-proxy/releases/latest/download/install.sh | sudo --preserve-env=FACTORY_API_KEY,PROXY_API_KEY bash -s -- --version v0.1.0
```

环境变量没有提供时保留已有凭据；明确提供新的 `FACTORY_API_KEY` 或 `PROXY_API_KEY` 时，仅更新对应值。不要把凭据写进源码目录或提交到 Git。使用已有 Factory 本机凭据的手动前台启动，也可省略 `FACTORY_API_KEY`；systemd 使用独立用户，通常应明确提供 API Key。

安装器先在暂存目录执行必要的源码检查，通过后切换 `current` 链接。只有源码、配置、运行时或服务定义发生变化时才重启服务，并检查 `/healthz`。重复运行时复用已验证内容、配置和运行时，跳过下载、复制、检查与重启。旧版本保留在 `releases`，上一次成功版本由 `previous` 指向；服务激活失败时恢复旧版本、环境文件与服务定义。

```bash
sudo systemctl status factory-anthropic-proxy
sudo journalctl -u factory-anthropic-proxy -n 100 --no-pager
sudo systemctl restart factory-anthropic-proxy
```

安装器只在用户运行时更新本机。GitHub 发布不会自动更新服务器。

## 不使用 systemd

使用自己的进程管理方式时，可安装到当前用户有权限的目录：

```bash
bash scripts/install.sh --source . --prefix "$HOME/.local/share/factory-anthropic-proxy" --config-dir "$HOME/.config/factory-anthropic-proxy" --no-service
PROXY_CONFIG="$HOME/.config/factory-anthropic-proxy/proxy.config.json" node "$HOME/.local/share/factory-anthropic-proxy/current/bin/proxy.mjs" serve
```

安装器会输出实际 Node.js 路径；若系统没有 Node.js，使用输出的私有运行时路径。`--no-service` 只安装与验证程序，不启动进程。`environment` 是 systemd 格式的配置文件，手动启动时请直接设置所需环境变量。

## 发布包与验证

`npm run package` 生成 `dist/factory-anthropic-proxy-<版本>.tgz`、`dist/install.sh` 和 `dist/SHA256SUMS`。包内容使用 `package.json` 的 `files` 白名单，并再次检查，禁止包含 `.env`、`proxy.config.json`、`.local`、`node_modules` 和 Git 元数据。

GitHub Actions 在 Windows 与原生 Ubuntu 上分别使用 Node.js 22、24 运行测试、语法检查和打包。Ubuntu Node.js 22 验证不注册服务的首次安装、重复运行跳过、升级保留配置、拒绝坏包及旧版本 HTTP 健康；Node.js 24 使用隔离的 systemd 单元与独立用户验证真实注册启动、重复安装 PID 不变、升级重启，以及新版本激活失败后的版本与环境回滚。本地 Windows 不代替这些 Linux 安装验证，也不使用 WSL。
