#!/usr/bin/env bash
# 远端后端部署脚本（在服务器上执行，由 cli.js deploy server 通过 ssh 'bash -s' 送入）
# 参数：应用名 服务端口 部署目录 发布包路径 Node版本
# 幂等：重复执行即重新发布；旧版本先备份到 <目录>/server.bak，健康检查不过自动回滚。
set -euo pipefail

APP_NAME=$1; APP_PORT=$2; DIR=$3; TAR=$4; NODE_VER=$5
log(){ printf '\033[36m[远端]\033[0m %s\n' "$*"; }
die(){ printf '\033[31m[远端失败]\033[0m %s\n' "$*" >&2; exit 1; }

# ---- 1) Node 运行时（无 Node 时自动安装，主源失败回落国内镜像）----
if ! command -v node >/dev/null 2>&1; then
  log "未检测到 Node，安装 $NODE_VER …"
  { curl -fsSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-x64.tar.gz" -o /tmp/node-install.tar.gz \
    || curl -fsSL "https://mirrors.aliyun.com/nodejs-release/$NODE_VER/node-$NODE_VER-linux-x64.tar.gz" -o /tmp/node-install.tar.gz; } \
    || die "Node 下载失败（检查服务器网络）"
  tar -xzf /tmp/node-install.tar.gz -C /usr/local --strip-components=1
  rm -f /tmp/node-install.tar.gz
fi
NODE_BIN=$(command -v node) || die "Node 安装异常"
log "Node 就绪：$($NODE_BIN --version)（$NODE_BIN）"

# ---- 2) 解压新版本（先备份旧版本）----
if [ -d "$DIR/server" ]; then
  rm -rf "${DIR}/server.bak"
  cp -a "$DIR/server" "${DIR}/server.bak"
  log "旧版本已备份 → ${DIR}/server.bak"
fi
mkdir -p "$DIR/server"
tar -xzf "$TAR" -C "$DIR/server" --strip-components=1
rm -f "$TAR"
log "新版本已解压到 $DIR/server"

# ---- 3) 生产依赖（不含 node_modules 上传：sharp 等平台二进制必须在服务器安装；
#         主源失败回落 npmmirror 镜像重试）----
cd "$DIR/server"
if [ -f package-lock.json ]; then INSTALL="npm ci --omit=dev"; else INSTALL="npm install --omit=dev"; fi
log "安装生产依赖（$INSTALL）…"
if ! $INSTALL --no-audit --no-fund; then
  log "主源安装失败，回落 npmmirror 镜像重试 …"
  $INSTALL --no-audit --no-fund --registry=https://registry.npmmirror.com \
    || die "依赖安装失败（看上方 npm 报错）"
fi
log "依赖就绪（node_modules 共 $(ls node_modules 2>/dev/null | wc -l) 个包）"

# ---- 4) systemd 常驻服务（单服务单端口：API 与 web 静态产物同源托管）----
cat > "/etc/systemd/system/${APP_NAME}.service" <<UNIT
[Unit]
Description=MoontentRN server (Koa: API + web 静态托管)
After=network.target

[Service]
Type=simple
WorkingDirectory=$DIR/server
ExecStart=$NODE_BIN src/index.js
Environment=NODE_ENV=production
Environment=PORT=$APP_PORT
Environment=SERVE_DIST=$DIR/web
Restart=always
RestartSec=3
MemoryMax=550M

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable "$APP_NAME" >/dev/null 2>&1 || true
systemctl restart "$APP_NAME"
log "服务 ${APP_NAME}.service 已重启（开机自启 + 崩溃自动拉起，SERVE_DIST=$DIR/web）"

# ---- 5) 防火墙放行（ufw 未启用则跳过）：主端口起连续 10 个端口一条范围规则
#      （主端口 + 分片端口段：server/src/lib/shard-ports.js 默认绑 APP_PORT+1..+9）----
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  SHARD_END=$((APP_PORT + 9))
  if ! ufw status | grep -qE "(^| )${APP_PORT}:${SHARD_END}/tcp"; then
    ufw allow "${APP_PORT}:${SHARD_END}/tcp" >/dev/null
    log "ufw 已放行 ${APP_PORT}-${SHARD_END}/tcp（主端口 + 分片端口段）"
  fi
fi

# ---- 6) 健康检查（/api/sites 探活；首次安装依赖/冷缓存较慢，给足 150 秒）----
log "等待服务就绪（最多 150 秒）…"
code=000
for _ in $(seq 1 150); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "http://127.0.0.1:${APP_PORT}/api/sites" || true)
  [ "$code" = 200 ] && break
  # 进程若已挂掉，立刻跳出等日志
  systemctl is-active --quiet "$APP_NAME" || break
  sleep 1
done

if [ "$code" = 200 ]; then
  log "部署成功 ✅ /api/sites HTTP 200 —— 后端服务运行中（端口 $APP_PORT）"
else
  echo "----- journalctl -u $APP_NAME 最近 80 行 -----"
  journalctl -u "$APP_NAME" -n 80 --no-pager || true
  # 健康检查不过：自动回滚到备份版本
  if [ -d "${DIR}/server.bak" ]; then
    log "健康检查未通过（状态码 $code），自动回滚到备份版本 …"
    rm -rf "${DIR}/server.rollback-keep" 2>/dev/null || true
    mv "$DIR/server" "${DIR}/server.rollback-keep"
    mv "${DIR}/server.bak" "$DIR/server"
    systemctl restart "$APP_NAME" || true
    sleep 2
    log "已回滚（故障版本保留在 ${DIR}/server.rollback-keep 由人工排查，确认无用后可删）"
  fi
  die "健康检查未通过（/api/sites $code），上方为服务日志"
fi
