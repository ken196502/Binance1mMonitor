#!/usr/bin/env bash
# ==========================================
# 容器启动入口：
#   1) 准备 mihomo 配置（挂载的 > 订阅生成的 provider 配置 > 内置默认）
#   2) 在容器内后台拉起 mihomo，并等待混合端口就绪
#   3) 把 PROXY / HTTPS_PROXY / HTTP_PROXY 指向容器内 mihomo
#      （Binance 行情与 Telegram 播报都由 undici EnvHttpProxyAgent 走该代理）
#   4) 前台启动应用（npm start），由 docker 管理生命周期
# ==========================================
set -euo pipefail

log() { printf '[entrypoint] %s\n' "$*"; }

MIHOMO_ENABLE="${MIHOMO_ENABLE:-1}"
MIHOMO_BIN="${MIHOMO_BIN:-/usr/local/bin/mihomo}"
MIHOMO_CONFIG_DIR="${MIHOMO_CONFIG_DIR:-/etc/mihomo}"
MIHOMO_PROXY_HOST="${MIHOMO_PROXY_HOST:-127.0.0.1}"
MIHOMO_PROXY_PORT="${MIHOMO_PROXY_PORT:-7890}"
MIHOMO_STARTUP_TIMEOUT="${MIHOMO_STARTUP_TIMEOUT:-40}"
MIHOMO_CONFIG_FILE="$MIHOMO_CONFIG_DIR/config.yaml"

MIHOMO_STARTED=0
MIHOMO_PID=""

# ------------------------------------------------------- 订阅内容判定与规范化
# 判断下载到的内容是否为 Clash / Mihomo 的 YAML 配置
is_clash_config() {
  grep -qE '^(proxies|proxy-groups|proxy-providers|mixed-port|port|socks-port)[[:space:]]*:' "$1"
}

# 统一下载订阅的监听端口：不同订阅源的 mixed-port / port / socks-port 各不相同
# （例如有的写 10801），若不改写，entrypoint 会探活本机 7890 端口而超时。
# 同时把控制端口收敛到容器回环地址，避免意外对外暴露。
normalize_mihomo_config() {
  local src="$1" dst="$2" port="$MIHOMO_PROXY_PORT"
  awk -v port="$port" '
    BEGIN { found = 0 }
    /^mixed-port[ \t]*:/ { print "mixed-port: " port; found = 1; next }
    /^(port|socks-port|redir-port|tproxy-port)[ \t]*:/ {
      print "# [entrypoint] disabled (unified to mixed-port): " $0; next
    }
    /^external-controller-tls[ \t]*:/ {
      print "# [entrypoint] disabled (needs TLS cert): " $0; next
    }
    /^external-controller[ \t]*:/ { print "external-controller: 127.0.0.1:9090"; next }
    { print }
    END { if (!found) print "mixed-port: " port }
  ' "$src" > "$dst"
}

# ------------------------------------------------ 方式 A：直接使用订阅作为配置
# 把订阅原样下载为 config.yaml（仅做端口规范化）。适合订阅本身已配好规则、
# 且其默认节点不被 Binance 屏蔽的场景；节点选择完全交给订阅。
download_raw_subscription() {
  local tmp="$MIHOMO_CONFIG_FILE.download" u i=0 total="$#"
  for u in "$@"; do
    i=$((i + 1))
    log "尝试订阅(raw) [$i/$total]: $u"
    local proxy_args=()
    if [ -n "${MIHOMO_SUBSCRIPTION_PROXY:-}" ]; then
      proxy_args=(--proxy "$MIHOMO_SUBSCRIPTION_PROXY")
    fi
    if curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 15 "${proxy_args[@]}" "$u" -o "$tmp"; then
      if is_clash_config "$tmp"; then
        normalize_mihomo_config "$tmp" "$MIHOMO_CONFIG_FILE"
        rm -f "$tmp"
        log "已应用订阅配置(raw): $MIHOMO_CONFIG_FILE（混合端口统一为 $MIHOMO_PROXY_PORT）"
        return 0
      fi
      log "警告: 该订阅不是 Clash/Mihomo YAML，跳过"
      rm -f "$tmp"
    else
      log "警告: 订阅下载失败，跳过"
      rm -f "$tmp"
    fi
  done
  return 1
}

# -------------------------------------------- 方式 B（默认）：订阅作为 provider
# 关键点：把订阅当作 mihomo 的 proxy-provider 加载，再用一个对 Binance 做
# 健康检查（expected-status=200）的 fallback 组挑选节点。这样即使宿主机/默认节点
# 位于被 Binance 屏蔽的地区（如美国机房），也能自动切换到能正常访问的节点，
# 避免 fapi.binance.com 返回 HTTP 451 导致行情与播报中断。
generate_provider_config() {
  local out="$1"; shift
  local urls=("$@")
  local hc="${MIHOMO_HEALTHCHECK_URL:-https://fapi.binance.com/fapi/v1/ping}"
  local hc_interval="${MIHOMO_HEALTHCHECK_INTERVAL:-600}"
  local provider_interval="${MIHOMO_PROVIDER_INTERVAL:-3600}"
  local i

  {
    printf '%s\n' \
      "# 本文件由 docker/entrypoint.sh 自动生成，请勿手工编辑（改订阅请设置 MIHOMO_SUBSCRIPTION_URL）。" \
      "# 订阅以 proxy-provider 方式加载；PROXY 组对 Binance 做健康检查（expected-status=200），" \
      "# 只挑选 Binance 不屏蔽的节点，自动规避 451。" \
      "" \
      "mixed-port: $MIHOMO_PROXY_PORT" \
      "allow-lan: false" \
      "mode: rule" \
      "log-level: ${MIHOMO_LOG_LEVEL:-info}" \
      "ipv6: false" \
      "unified-delay: true" \
      "tcp-concurrent: true" \
      "external-controller: 127.0.0.1:9090" \
      "profile:" \
      "  store-selected: true" \
      "  store-fake-ip: true" \
      "dns:" \
      "  enable: true" \
      "  ipv6: false" \
      "  enhanced-mode: fake-ip" \
      "  fake-ip-range: 198.18.0.1/16" \
      "  nameserver:" \
      "    - 223.5.5.5" \
      "    - 119.29.29.29" \
      "  fallback:" \
      "    - 8.8.8.8" \
      "    - 1.1.1.1" \
      "" \
      "proxy-providers:"

    i=1
    for u in "${urls[@]}"; do
      printf '%s\n' \
        "  sub${i}:" \
        "    type: http" \
        "    url: \"${u}\"" \
        "    interval: ${provider_interval}" \
        "    path: ./providers/sub${i}.yaml" \
        "    health-check:" \
        "      enable: true" \
        "      url: \"${hc}\"" \
        "      interval: ${hc_interval}" \
        "      expected-status: 200"
      i=$((i + 1))
    done

    printf '%s\n' \
      "" \
      "proxy-groups:" \
      "  # 自动选节点：只在能 200 命中 Binance 的节点里挑选，节点失效时自动切换" \
      "  - name: PROXY" \
      "    type: fallback" \
      "    url: \"${hc}\"" \
      "    interval: ${hc_interval}" \
      "    expected-status: 200" \
      "    use:"
    i=1
    for _ in "${urls[@]}"; do printf '      - sub%s\n' "$i"; i=$((i + 1)); done

    printf '%s\n' \
      "  # 手动指定节点（需要时可通过 /etc/mihomo 的 Clash API 把 PROXY 切到某个节点）" \
      "  - name: MANUAL" \
      "    type: select" \
      "    use:"
    i=1
    for _ in "${urls[@]}"; do printf '      - sub%s\n' "$i"; i=$((i + 1)); done

    printf '%s\n' \
      "" \
      "rules:" \
      "  - DOMAIN-SUFFIX,binance.com,PROXY" \
      "  - DOMAIN-SUFFIX,binancefuture.com,PROXY" \
      "  - DOMAIN-SUFFIX,bnbstatic.com,PROXY" \
      "  - DOMAIN-SUFFIX,telegram.org,PROXY" \
      "  - DOMAIN-SUFFIX,telegram.me,PROXY" \
      "  - DOMAIN-SUFFIX,t.me,PROXY" \
      "  - DOMAIN-SUFFIX,telegra.ph,PROXY" \
      "  - MATCH,PROXY"
  } > "$out"
}

# ---------------------------------------------------------------- 配置准备
prepare_mihomo_config() {
  mkdir -p "$MIHOMO_CONFIG_DIR"

  # 1) 用户挂载 / 预先放好的配置优先，绝不覆盖
  if [ -f "$MIHOMO_CONFIG_FILE" ]; then
    log "使用已有 mihomo 配置: $MIHOMO_CONFIG_FILE"
    return 0
  fi

  # 2) 订阅地址：支持多个（用逗号 / 分号 / 空格 / 换行分隔），按顺序尝试
  local raw="${MIHOMO_SUBSCRIPTION_URL:-${MIHOMO_CONFIG_URL:-}}"
  local urls=() u
  if [ -n "$raw" ]; then
    while IFS= read -r u; do
      [ -n "$u" ] && urls+=("$u")
    done < <(printf '%s\n' "$raw" | tr ',;' '\n\n' | tr -s '[:space:]' '\n')
  fi

  if [ "${#urls[@]}" -gt 0 ]; then
    # raw：订阅直接作为配置；provider（默认）：订阅作为 provider + Binance 健康检查选点
    if [ "${MIHOMO_CONFIG_MODE:-provider}" = "raw" ] && download_raw_subscription "${urls[@]}"; then
      return 0
    fi
    generate_provider_config "$MIHOMO_CONFIG_FILE" "${urls[@]}"
    log "已生成 provider 配置: $MIHOMO_CONFIG_FILE（订阅数 ${#urls[@]}，PROXY 组按 Binance 健康检查自动选节点）"
    return 0
  fi

  # 3) 兜底：内置默认配置（全直连）
  if [ -f "$MIHOMO_CONFIG_DIR/config.default.yaml" ]; then
    cp "$MIHOMO_CONFIG_DIR/config.default.yaml" "$MIHOMO_CONFIG_FILE"
    log "未提供代理节点，使用内置默认配置（全部直连）: $MIHOMO_CONFIG_FILE"
  else
    log "警告: 找不到 $MIHOMO_CONFIG_DIR/config.default.yaml，无法启动 mihomo"
    return 1
  fi
}

# ---------------------------------------------------------------- 启动 mihomo
start_mihomo() {
  if [ "$MIHOMO_ENABLE" = "0" ]; then
    log "MIHOMO_ENABLE=0，跳过容器内 mihomo"
    return 0
  fi

  if [ ! -x "$MIHOMO_BIN" ]; then
    log "警告: 找不到 mihomo 可执行文件 $MIHOMO_BIN，跳过容器内代理"
    return 0
  fi

  if ! prepare_mihomo_config; then
    return 0
  fi

  log "启动 mihomo (配置目录: $MIHOMO_CONFIG_DIR, 混合端口: $MIHOMO_PROXY_HOST:$MIHOMO_PROXY_PORT)"
  # shellcheck disable=SC2086
  "$MIHOMO_BIN" -d "$MIHOMO_CONFIG_DIR" ${MIHOMO_EXTRA_ARGS:-} &
  MIHOMO_PID=$!
  MIHOMO_STARTED=1

  # 等待混合端口可连接（bash 的 /dev/tcp 探活，无需额外工具）
  local i
  for ((i = 1; i <= MIHOMO_STARTUP_TIMEOUT; i++)); do
    if ! kill -0 "$MIHOMO_PID" 2>/dev/null; then
      log "警告: mihomo 已退出（配置有误？请检查上方 mihomo 日志），监控将无法使用容器内代理"
      MIHOMO_STARTED=0
      return 0
    fi
    if (: > "/dev/tcp/$MIHOMO_PROXY_HOST/$MIHOMO_PROXY_PORT") 2>/dev/null; then
      log "mihomo 已就绪: http://$MIHOMO_PROXY_HOST:$MIHOMO_PROXY_PORT"
      return 0
    fi
    sleep 1
  done

  log "警告: 等待 mihomo 端口超时（$MIHOMO_STARTUP_TIMEOUT 秒），继续启动应用"
}

# ------------------------------------------------------------ 注入代理变量
configure_proxy_env() {
  if [ "$MIHOMO_ENABLE" = "0" ] || [ "$MIHOMO_STARTED" != "1" ]; then
    return 0
  fi

  if [ -n "${PROXY:-}${BINANCE_PROXY:-}${HTTPS_PROXY:-}${HTTP_PROXY:-}${https_proxy:-}${http_proxy:-}" ]; then
    log "检测到已显式配置的代理环境变量，沿用原有设置（如需改用容器内 mihomo 请清空 PROXY）"
    return 0
  fi

  local addr="http://$MIHOMO_PROXY_HOST:$MIHOMO_PROXY_PORT"
  export PROXY="$addr"
  export HTTPS_PROXY="$addr"
  export HTTP_PROXY="$addr"
  export https_proxy="$addr"
  export http_proxy="$addr"
  export NO_PROXY="${NO_PROXY:-localhost,127.0.0.1,::1}"
  export no_proxy="${no_proxy:-$NO_PROXY}"
  log "已将 PROXY / HTTPS_PROXY / HTTP_PROXY 指向容器内 mihomo: $addr"
}

# ------------------------------------------------------------------ 收尾清理
shutdown() {
  if [ -n "$MIHOMO_PID" ]; then
    kill "$MIHOMO_PID" 2>/dev/null || true
  fi
}
trap shutdown EXIT

# ---------------------------------------------------------------------- main
start_mihomo
configure_proxy_env

if [ "$#" -eq 0 ]; then
  set -- npm start
fi

log "启动应用: $*"
exec "$@"
