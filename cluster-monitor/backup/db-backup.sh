#!/bin/sh
# Sub2API 数据库每日备份：在副节点上跑，从主节点的数据库导出一份完整备份，存在副节点自己的硬盘上。
# 主节点整台出事时，数据还在另一台机器上。
#
# - pg_dump 用 postgres 官方镜像里的（要和数据库同一个大版本，用 PG_IMAGE 指定）。
# - 数据库地址、库名、账号、密码，从这台机器上的 Sub2API 容器的环境变量里读：
#   这台机器的 Sub2API 本来就要连这个数据库，不新建任何存密码的文件。密码只经环境变量传，不出现在命令行里。
# - 先写成隐藏的临时文件，确认能读出目录（pg_restore --list）后才改成正式文件名；失败的半成品会删掉。
# - 只留最新的 KEEP 份（默认 7 份）。按份数删、不按天数删：备份连续失败几天，也不会把好的备份删光。
# - SKIP_DATA_TABLES 里的表只备份表结构、不备份内容（默认是系统日志表：只是排错用的日志，占了数据库一半多）。
# - 备份目录的属组设成 READER_GROUP（面板 agent 的用户组）：agent 能看到最新一份的时间和大小，读不了内容。
#
# 用法（root 身份，cron 每天跑一次，见 db-backup.cron.example）：
#   BACKUP_DIR=/var/backups/sub2api-db READER_GROUP=cluster-agent db-backup.sh
set -eu
# 注意：变量后面紧跟中文时一律写成 ${VAR}。macOS 自带的 bash 3.2 在 UTF-8 环境下会把紧跟的中文当成变量名的一部分。

BACKUP_DIR=${BACKUP_DIR:-/var/backups/sub2api-db}
SOURCE_CONTAINER=${SOURCE_CONTAINER:-sub2api}
PG_IMAGE=${PG_IMAGE:-postgres:18-alpine}
KEEP=${KEEP:-7}
SKIP_DATA_TABLES=${SKIP_DATA_TABLES:-ops_system_logs}
MIN_FREE_MB=${MIN_FREE_MB:-5120}
READER_GROUP=${READER_GROUP:-}
PREFIX=${PREFIX:-sub2api}

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
fail() { log "失败：${*}"; exit 1; }

case "$KEEP" in ''|*[!0-9]*) fail "KEEP 要填正整数" ;; esac
[ "$KEEP" -ge 1 ] || fail "KEEP 至少是 1"

umask 077
mkdir -p "$BACKUP_DIR"
if [ -n "$READER_GROUP" ]; then
  chgrp "$READER_GROUP" "$BACKUP_DIR"
  chmod 750 "$BACKUP_DIR"
else
  chmod 700 "$BACKUP_DIR"
fi

# 同一时间只跑一份
if command -v flock >/dev/null 2>&1; then
  exec 9>"$BACKUP_DIR/.lock"
  flock -n 9 || fail "上一次备份还没跑完"
fi

free_mb=$(df -Pm "$BACKUP_DIR" | awk 'NR == 2 { print $4 }')
[ "${free_mb:-0}" -ge "$MIN_FREE_MB" ] || fail "硬盘只剩 ${free_mb:-?} MB，不到 ${MIN_FREE_MB} MB，这次不备份"

# 从 Sub2API 容器的环境变量里取一项
container_env() {
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$SOURCE_CONTAINER" | sed -n "s/^$1=//p" | head -n 1
}
DB_HOST=$(container_env DATABASE_HOST)
DB_PORT=$(container_env DATABASE_PORT)
DB_USER=$(container_env DATABASE_USER)
DB_NAME=$(container_env DATABASE_DBNAME)
PGPASSWORD=$(container_env DATABASE_PASSWORD)
export PGPASSWORD
if [ -z "$DB_HOST" ] || [ -z "$DB_USER" ] || [ -z "$DB_NAME" ]; then
  fail "从容器 ${SOURCE_CONTAINER} 读不到数据库的地址、账号或库名"
fi
DB_PORT=${DB_PORT:-5432}

name="$PREFIX-$(date -u +%Y%m%dT%H%M%SZ).dump"
partial=".$name.partial"
trap 'rm -f "$BACKUP_DIR/$partial"' EXIT

set --
for table in $SKIP_DATA_TABLES; do
  set -- "$@" "--exclude-table-data=$table"
done

log "开始备份 ${DB_NAME}（${DB_HOST}:${DB_PORT}）"
# 容器里也用 umask 077：文件从一开始就只有 root 能读
docker run --rm --network host -e PGPASSWORD -v "$BACKUP_DIR:/backup" "$PG_IMAGE" \
  sh -c 'umask 077 && exec pg_dump "$@"' pg_dump \
  -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -Fc "$@" -f "/backup/$partial" \
  || fail "pg_dump 没跑完"
[ -s "$BACKUP_DIR/$partial" ] || fail "导出的文件是空的"
docker run --rm -v "$BACKUP_DIR:/backup:ro" "$PG_IMAGE" pg_restore --list "/backup/$partial" > /dev/null \
  || fail "导出的文件读不出目录，可能不完整"

mv "$BACKUP_DIR/$partial" "$BACKUP_DIR/$name"
chmod 600 "$BACKUP_DIR/$name"
log "完成：${name}，$(wc -c < "$BACKUP_DIR/$name" | tr -d ' ') 字节"

# 只留最新的 KEEP 份
ls -1t "$BACKUP_DIR"/"$PREFIX"-*.dump | tail -n +"$((KEEP + 1))" | while IFS= read -r old; do
  rm -f -- "$old"
  log "删掉旧备份：$(basename "$old")"
done
