# syntax=docker/dockerfile:1

# ==========================================
# 阶段 1：构建前端 React SPA (Vite + TypeScript)
# ==========================================
FROM node:22-slim AS web-builder

WORKDIR /app/web

# 优先安装依赖，利用 Docker 层缓存
COPY web/package*.json ./
RUN npm ci

# 复制前端源码并构建到 web/dist
COPY web/ ./
RUN npm run build

# ==========================================
# 阶段 2：生产运行镜像
# ==========================================
FROM node:22-slim

# 安装必要证书及设置时区支持
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    tzdata \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production \
    PORT=4111 \
    TZ=Asia/Shanghai

# 安装服务端生产依赖（排除开发依赖）
COPY package*.json ./
RUN npm ci --omit=dev

# 复制服务端源码与配置
COPY tsconfig.json ./
COPY src/ ./src/

# 从阶段 1 复制前端静态构建产物至 web/dist
COPY --from=web-builder /app/web/dist ./web/dist

# 修正目录归属并切换到内置非 root 用户 node
RUN chown -R node:node /app
USER node

EXPOSE 4111

# 健康检查：检查 HTTP 根路由服务状态
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4111) + '/').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["npm", "start"]
