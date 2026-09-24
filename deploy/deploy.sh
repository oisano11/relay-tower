#!/usr/bin/env bash
# 中转塔台一键部署：同步 upstream-monitor 代码到服务器，重建容器，健康检查失败自动回滚。
#
# 用法：
#   ./deploy/deploy.sh <用户@服务器 或 ~/.ssh/config 里的别名> [服务器上的塔台目录] [SSH端口]
#   例：./deploy/deploy.sh my-server
#       ./deploy/deploy.sh root@1.2.3.4 /opt/relay-tower 22
#   目录可省略：会从正在运行的 upstream-monitor 容器自动找到，并沿用它的 compose 项目名、配置文件和端口。
#   目录支持两种结构：仓库结构（docker-compose.yml + upstream-monitor/）
#                     独立结构（目录里直接是 upstream-monitor 代码和它自己的 docker-compose.yml）
# 可选环境变量：
#   DRY_RUN=1        只打印将执行的操作，不做任何改动
#   SKIP_TESTS=1     跳过本地测试（不建议）
#   HEALTH_PORT=3300 塔台端口（默认读取容器实际映射的端口）
#
# 不会上传或覆盖：data（运行数据与配置）、.env、node_modules、服务器上的 *.bak* 手工备份。
set -euo pipefail

TARGET="${1:-}"; REMOTE_DIR="${2:-}"; PORT="${3:-}"
if [[ -z "$TARGET" ]]; then
  sed -n '2,14p' "$0"; exit 1
fi
cd "$(dirname "$0")/.."
LOCAL_DIR="$(pwd)/upstream-monitor"
STAMP="$(date +%Y%m%d-%H%M%S)"
# 不指定端口时沿用 ~/.ssh/config 里的端口、密钥和代理设置。
SSH_OPTS=(-o ConnectTimeout=15); [[ -n "$PORT" ]] && SSH_OPTS+=(-p "$PORT")
SSH=(ssh "${SSH_OPTS[@]}" "$TARGET")
RSYNC_SSH="ssh ${SSH_OPTS[*]}"
run() { if [[ "${DRY_RUN:-}" == 1 ]]; then echo "[DRY_RUN] $*"; else "$@"; fi; }
step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

step "1/6 本地检查"
[[ -f "$LOCAL_DIR/server.js" && -f "$LOCAL_DIR/account-split.js" ]] || { echo "找不到 upstream-monitor 代码"; exit 1; }
if ! command -v node >/dev/null 2>&1; then
  echo "本机没有 Node.js，跳过本地测试（代码已在开发环境通过全部测试）。"; SKIP_TESTS=1
else
  for f in "$LOCAL_DIR"/*.js "$LOCAL_DIR"/public/app.js; do node --check "$f"; done
fi
if [[ "${SKIP_TESTS:-}" != 1 ]]; then (cd "$LOCAL_DIR" && npm test >/tmp/relay-tower-test.log 2>&1) \
  && echo "测试通过：$(grep -E '^# pass' /tmp/relay-tower-test.log | tail -1)" \
  || { echo "本地测试失败，已中止部署。日志：/tmp/relay-tower-test.log"; exit 1; }; fi

step "2/6 检查服务器"
"${SSH[@]}" true || { echo "连不上服务器 $TARGET（如果平时要先开代理/VPN，请先打开）"; exit 1; }
# 非 root 用户：优先直接用 docker，否则尝试免密 sudo。
if "${SSH[@]}" "docker ps >/dev/null 2>&1"; then SUDO=""
elif "${SSH[@]}" "sudo -n docker ps >/dev/null 2>&1"; then SUDO="sudo -n "
else echo "服务器用户没有 docker 权限，且 sudo 需要密码。请把该用户加入 docker 组，或配置免密 sudo。"; exit 1; fi
# 记下正在运行的容器来自哪个 compose 项目和配置文件，重建时原样沿用，避免另起一个项目抢同名容器。
LABELS="$("${SSH[@]}" "${SUDO}docker inspect upstream-monitor --format '{{ index .Config.Labels \"com.docker.compose.project.working_dir\" }}|{{ index .Config.Labels \"com.docker.compose.project\" }}|{{ index .Config.Labels \"com.docker.compose.project.config_files\" }}' 2>/dev/null" || true)"
IFS='|' read -r RUN_DIR RUN_PROJECT RUN_CONFIGS <<<"$LABELS"
if [[ -z "$REMOTE_DIR" ]]; then
  REMOTE_DIR="$RUN_DIR"
  [[ -n "$REMOTE_DIR" ]] || { echo "没能自动找到塔台目录，请在命令后面补上服务器上塔台所在目录"; exit 1; }
  echo "自动找到塔台目录：$REMOTE_DIR"
fi
REMOTE_DIR="${REMOTE_DIR%/}"
if "${SSH[@]}" "test -f '$REMOTE_DIR/docker-compose.yml' && test -f '$REMOTE_DIR/upstream-monitor/server.js'"; then
  CODE_DIR="$REMOTE_DIR/upstream-monitor"; LAYOUT=仓库结构
elif "${SSH[@]}" "test -f '$REMOTE_DIR/docker-compose.yml' && test -f '$REMOTE_DIR/server.js'"; then
  CODE_DIR="$REMOTE_DIR"; LAYOUT=独立结构
else
  echo "服务器上的 $REMOTE_DIR 既不是仓库结构（docker-compose.yml + upstream-monitor/），也不是独立结构（docker-compose.yml + server.js），请确认目录"; exit 1
fi
DC="$("${SSH[@]}" "${SUDO}docker compose version >/dev/null 2>&1 && echo 'docker compose' || (command -v docker-compose >/dev/null && echo 'docker-compose')" || true)"
[[ -n "$DC" ]] || { echo "服务器上没有 docker compose"; exit 1; }
if [[ -n "$RUN_PROJECT" && "$RUN_DIR" == "$REMOTE_DIR" ]]; then
  DC+=" -p '$RUN_PROJECT'"
  IFS=',' read -ra CFGS <<<"$RUN_CONFIGS"
  for c in ${CFGS[@]+"${CFGS[@]}"}; do DC+=" -f '$c'"; done
fi
# 独立结构的 compose 需要 DOCKER_GID；目录里没有 .env 时从正在运行的容器沿用，保证重建前后配置一致。
ENVS=""
if [[ "$LAYOUT" == 独立结构 ]] && ! "${SSH[@]}" "test -f '$REMOTE_DIR/.env'"; then
  # 密码、密钥如果是当初在命令行临时传入的，脚本不搬运这类机密，先让人写进 .env，免得重建后丢失。
  if "${SSH[@]}" "${SUDO}docker inspect upstream-monitor --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | grep -Eq '^(ADMIN_PASSWORD|GATEWAY_API_KEY|TELEGRAM_BOT_TOKEN)=.'"; then
    echo "当前容器带有非空的 ADMIN_PASSWORD / GATEWAY_API_KEY / TELEGRAM_BOT_TOKEN，但 $REMOTE_DIR 下没有 .env。"
    echo "请先把这些值写进 $REMOTE_DIR/.env（chmod 600）再部署，否则重建后会丢失。"; exit 1
  fi
  GID="$("${SSH[@]}" "stat -c %g /var/run/docker.sock" || true)"
  [[ "$GID" =~ ^[0-9]+$ ]] || { echo "读不到服务器上 /var/run/docker.sock 的组 ID"; exit 1; }
  ENVS="env DOCKER_GID=$GID "
  VOL="$("${SSH[@]}" "${SUDO}docker inspect upstream-monitor --format '{{range .Mounts}}{{if eq .Destination \"/app/data\"}}{{.Name}}{{end}}{{end}}' 2>/dev/null" || true)"
  [[ "$VOL" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] && ENVS+="UPSTREAM_MONITOR_DATA_VOLUME=$VOL "
  echo "目录里没有 .env，沿用当前容器配置：DOCKER_GID=$GID${VOL:+，数据卷 $VOL}"
fi
COMPOSE="${SUDO}${ENVS}${DC}"
if [[ -z "${HEALTH_PORT:-}" ]]; then
  HEALTH_PORT="$("${SSH[@]}" "${SUDO}docker port upstream-monitor 3300/tcp 2>/dev/null | head -1 | sed 's/.*://'" || true)"
  [[ "$HEALTH_PORT" =~ ^[0-9]+$ ]] || HEALTH_PORT=3300
fi
# 备份放在代码目录旁边（独立结构下不能放进代码目录，否则会被同步删除、也会被打进镜像构建上下文）。
TAR_PARENT="${CODE_DIR%/*}"; TAR_NAME="${CODE_DIR##*/}"; BACKUP_DIR="$TAR_PARENT/.deploy-backups"
# 目录不可写（例如属于 root）时，备份和同步也走免密 sudo。
FSUDO=""; RSYNC_PATH=()
if ! "${SSH[@]}" "test -w '$CODE_DIR' && test -w '$TAR_PARENT'"; then FSUDO="sudo -n "; RSYNC_PATH=(--rsync-path="sudo -n rsync"); fi
echo "服务器就绪（$LAYOUT，健康检查端口 $HEALTH_PORT），使用：$COMPOSE${FSUDO:+（文件操作使用 sudo）}"

step "3/6 备份服务器上的旧代码（不含 data）"
BACKUP="$BACKUP_DIR/$TAR_NAME-$STAMP.tgz"
run "${SSH[@]}" "${FSUDO}mkdir -p '$BACKUP_DIR' && cd '$TAR_PARENT' && ${FSUDO}tar --exclude='$TAR_NAME/data' --exclude='$TAR_NAME/node_modules' --exclude='$TAR_NAME/.env' -czf '$BACKUP' '$TAR_NAME' && ls -t '$BACKUP_DIR/$TAR_NAME'-*.tgz | tail -n +6 | xargs -r ${FSUDO}rm -f"
echo "备份：$BACKUP"

step "4/6 同步新代码"
# macOS 自带 bash 3.2 在 set -u 下展开空数组会报错，所以用 ${arr[@]+...} 写法。
run rsync -az --delete -e "$RSYNC_SSH" ${RSYNC_PATH[@]+"${RSYNC_PATH[@]}"} \
  --exclude 'data/' --exclude 'node_modules/' --exclude '.env' --exclude '*.log' --exclude '*.bak*' \
  "$LOCAL_DIR/" "$TARGET:$CODE_DIR/"

REBUILD="cd '$REMOTE_DIR' && $COMPOSE build upstream-monitor && $COMPOSE up -d --no-deps upstream-monitor"
ROLLBACK="cd '$TAR_PARENT' && ${FSUDO}tar -xzf '$BACKUP' && $REBUILD"
rollback() {
  echo -e "\n\033[1;31m$1，自动回滚到旧版本...\033[0m"
  "${SSH[@]}" "cd '$REMOTE_DIR' && $COMPOSE logs --tail 40 upstream-monitor" || true
  "${SSH[@]}" "$ROLLBACK" || { echo "自动回滚也失败了，请手动执行：${SSH[*]} \"$ROLLBACK\""; exit 1; }
  echo "已回滚。请把上面的输出发给 Claude 排查。"
  exit 1
}

step "5/6 重建并重启塔台容器（Sub2API、数据库、Redis 不受影响）"
run "${SSH[@]}" "$REBUILD" || rollback "重建或启动失败"

step "6/6 健康检查"
if [[ "${DRY_RUN:-}" == 1 ]]; then echo "[DRY_RUN] 跳过健康检查（端口 $HEALTH_PORT）"; exit 0; fi
ok=0
for i in $(seq 1 20); do
  sleep 3
  if "${SSH[@]}" "curl -fsS -m 5 http://127.0.0.1:$HEALTH_PORT/api/auth/status >/dev/null"; then ok=1; break; fi
done
if [[ "$ok" == 1 ]]; then
  echo -e "\n\033[1;32m部署成功。\033[0m请打开控制台，在右上角【⚙️ 系统管理 → 🧭 切号预演】核对各分组。"
  echo "如需手动回滚：${SSH[*]} \"$ROLLBACK\""
  exit 0
fi
rollback "健康检查失败"
