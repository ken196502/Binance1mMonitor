# syntax=docker/dockerfile:1

# ==========================================
# 阶段 1：构建前端 React SPA (Vite + TypeScript)
# ==========================================
FROM node:22-slim AS web-builder

WORKDIR /app

# 根依赖：前端 `tsc -b` 会经 web/src → ../src/types.ts → ../src/binance.ts 做类型检查，
# 需要根目录的 undici 与 @types/node（否则报 Cannot find module 'undici' / process）
COPY package*.json ./
RUN npm ci

# 前端类型检查所依赖的服务端源码
COPY tsconfig.json ./
COPY src/ ./src/

WORKDIR /app/web

# 优先安装依赖，利用 Docker 层缓存
COPY web/package*.json ./
RUN npm ci

# 复制前端源码并构建到 web/dist
COPY web/ ./
RUN npm run build

# ==========================================
# 阶段 2：下载 mihomo 内核与 Geo 数据（仅用于 COPY，不进最终镜像）
# ==========================================
FROM debian:bookworm-slim AS mihomo-fetch

# 版本与下载地址（构建时可覆盖，例如国内网络用镜像前缀：
#   docker build --build-arg MIHOMO_DOWNLOAD_BASE=https://gh-proxy.com/https://github.com/MetaCubeX/mihomo/releases/download .）
ARG MIHOMO_VERSION=v1.19.32
ARG MIHOMO_DOWNLOAD_BASE=https://github.com/MetaCubeX/mihomo/releases/download
ARG MIHOMO_GEO_BASE=https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest
ARG TARGETARCH

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gzip \
  && rm -rf /var/lib/apt/lists/*

# 内核：按目标架构挑对应产物（mihomo-linux-<arch>-<version>.gz）
RUN set -eux; \
    case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
      amd64) ARCH=amd64 ;; \
      arm64) ARCH=arm64 ;; \
      arm)   ARCH=armv7 ;; \
      *) echo "不支持的架构: ${TARGETARCH}"; exit 1 ;; \
    esac; \
    URL="${MIHOMO_DOWNLOAD_BASE}/${MIHOMO_VERSION}/mihomo-linux-${ARCH}-${MIHOMO_VERSION}.gz"; \
    echo "下载 mihomo: ${URL}"; \
    (curl -fsSL --retry 3 --connect-timeout 20 "$URL" -o /tmp/mihomo.gz) \
      || curl -fsSL --retry 3 --connect-timeout 20 "https://gh-proxy.com/${URL}" -o /tmp/mihomo.gz; \
    gunzip -c /tmp/mihomo.gz > /usr/local/bin/mihomo; \
    chmod +x /usr/local/bin/mihomo; \
    /usr/local/bin/mihomo -v

# Geo 数据：离线随镜像分发，避免容器每次启动去 GitHub 拉取（拉取失败不影响构建）
RUN set -eux; \
    mkdir -p /mihomo-geo; \
    for f in geoip.metadb geosite.dat; do \
      (curl -fsSL --retry 3 --connect-timeout 20 "${MIHOMO_GEO_BASE}/${f}" -o "/mihomo-geo/${f}") \
        || curl -fsSL --retry 3 --connect-timeout 20 "https://gh-proxy.com/${MIHOMO_GEO_BASE}/${f}" -o "/mihomo-geo/${f}" \
        || echo "警告: 下载 ${f} 失败，容器首次启动时 mihomo 会自行尝试下载"; \
    done; \
    ls -al /mihomo-geo

# ==========================================
# 阶段 3：生产运行镜像（监控面板与实时播报服务 + 容器内 mihomo 代理）
# ==========================================
FROM node:22-slim

# 安装必要证书、时区支持，以及 entrypoint 拉取 mihomo 订阅所需的 curl
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    tzdata \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production \
    PORT=4111 \
    TZ=Asia/Shanghai

# 安装服务端生产依赖（排除开发依赖与测试工具）
COPY package*.json ./
RUN npm ci --omit=dev

# 仅复制服务端核心源码与配置（不复制 research、reports、data 等回测研究模块）
COPY tsconfig.json ./
COPY src/ ./src/

# 容器内代理：mihomo 内核 + 默认配置 + Geo 数据 + 启动脚本
COPY --from=mihomo-fetch /usr/local/bin/mihomo /usr/local/bin/mihomo
COPY --from=mihomo-fetch /mihomo-geo/ /etc/mihomo/
COPY docker/mihomo/config.default.yaml /etc/mihomo/config.default.yaml
COPY docker/entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
  && mihomo -v

# 从阶段 1 复制前端静态构建产物至 web/dist
COPY --from=web-builder /app/web/dist ./web/dist

# 修正目录归属并切换到内置非 root 用户 node（mihomo 需要在配置目录写 cache.db）
RUN chown -R node:node /app /etc/mihomo
USER node

EXPOSE 4111

# 健康检查：检查 HTTP 根路由服务状态
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4111) + '/').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# 入口脚本先拉起容器内 mihomo，再把 PROXY 指向它，最后 exec npm start
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["npm", "start"]
