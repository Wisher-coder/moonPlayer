#!/usr/bin/env bash
# 远端 web 站点部署脚本（在服务器上执行，由 cli.js deploy web 通过 ssh 'bash -s' 送入）
# 参数：应用名 服务端口 部署目录 发布包路径
# 产物解压到 <目录>/web；后端服务的 koa-static 在「启动时」挂载 SERVE_DIST，
# 故发布后一律重启服务（首次 deploy web 前目录不存在时尤须如此）。
# 幂等：重复执行即重新发布；旧版本先备份到 <目录>/web.bak，探活不过自动回滚。
set -euo pipefail

APP_NAME=$1; APP_PORT=$2; DIR=$3; TAR=$4
log(){ printf '\033[36m[远端]\033[0m %s\n' "$*"; }
die(){ printf '\033[31m[远端失败]\033[0m %s\n' "$*" >&2; exit 1; }

# ---- 1) 解压新版本（先备份旧版本）----
if [ -d "$DIR/web" ]; then
  rm -rf "${DIR}/web.bak"
  cp -a "$DIR/web" "${DIR}/web.bak"
  log "旧版本已备份 → ${DIR}/web.bak"
fi
mkdir -p "$DIR/web"
tar -xzf "$TAR" -C "$DIR/web" --strip-components=1
rm -f "$TAR"
log "新版本已解压到 $DIR/web（共 $(find "$DIR/web" -type f | wc -l) 个文件）"

# ---- 2) 重启后端服务加载最新静态产物；服务尚不存在时只提示不报错 ----
if systemctl cat "$APP_NAME" >/dev/null 2>&1; then
  systemctl restart "$APP_NAME"
  log "服务 ${APP_NAME}.service 已重启（加载最新静态产物）"
else
  log "警告：${APP_NAME}.service 尚不存在 —— web 产物已就位，请先在本地执行 node cli.js deploy server"
  exit 0
fi

# ---- 3) 健康检查：首页 200 且含应用根挂载点 id=\"root\"；/api/sites 200 ----
log "等待站点就绪（最多 150 秒）…"
code=000; body=""
for _ in $(seq 1 150); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "http://127.0.0.1:${APP_PORT}/" || true)
  if [ "$code" = 200 ]; then
    body=$(curl -s --max-time 8 "http://127.0.0.1:${APP_PORT}/" || true)
    printf '%s' "$body" | grep -q 'id="root"' && break
    code=000
  fi
  systemctl is-active --quiet "$APP_NAME" || break
  sleep 1
done
api_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "http://127.0.0.1:${APP_PORT}/api/sites" || true)

if [ "$code" = 200 ] && [ "$api_code" = 200 ]; then
  log "部署成功 ✅ 首页 HTTP $code（含根挂载点）/ api/sites HTTP $api_code —— web 站点运行中"
else
  echo "----- journalctl -u $APP_NAME 最近 40 行 -----"
  journalctl -u "$APP_NAME" -n 40 --no-pager || true
  if [ -d "${DIR}/web.bak" ]; then
    log "探活未通过（首页 $code / api/sites $api_code），自动回滚到备份版本 …"
    rm -rf "${DIR}/web.rollback-keep" 2>/dev/null || true
    mv "$DIR/web" "${DIR}/web.rollback-keep"
    mv "${DIR}/web.bak" "$DIR/web"
    systemctl restart "$APP_NAME" || true
    sleep 2
    log "已回滚（故障版本保留在 ${DIR}/web.rollback-keep 由人工排查，确认无用后可删）"
  fi
  die "健康检查未通过（首页 $code / api/sites $api_code），上方为服务日志"
fi
