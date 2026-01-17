#
# Antigravity Proxy - Docker 镜像构建文件
#
# 单容器构建:
# - 构建 Node 后端依赖（包括 better-sqlite3 原生插件）
# - 运行时仅运行后端，通过 @fastify/static 提供静态文件服务
#

# ============ 构建阶段 ============
FROM node:20-alpine AS backend-builder

WORKDIR /app/backend

# 安装 better-sqlite3 编译依赖
RUN apk add --no-cache python3 make g++

# 复制依赖文件并安装
COPY backend/package*.json ./
RUN npm install --omit=dev

# 复制后端源码
COPY backend/ ./

# ============ 运行阶段 ============
FROM node:20-alpine AS runtime

# 镜像元信息
LABEL org.opencontainers.image.title="Antigravity Proxy"
LABEL org.opencontainers.image.description="AI API 代理服务，支持 Claude/Gemini 等多种模型"
LABEL org.opencontainers.image.source="https://github.com/nicecai/Antigravity-Proxy"
LABEL org.opencontainers.image.licenses="MIT"

WORKDIR /app

# 创建非 root 用户以提升安全性
RUN addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup

# 复制后端代码和依赖
COPY --from=backend-builder --chown=appuser:appgroup /app/backend /app/backend

# 创建数据目录并设置权限
RUN mkdir -p /app/data && chown -R appuser:appgroup /app/data

# 切换到非 root 用户
USER appuser

# 暴露端口
EXPOSE 3000

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget -q --spider http://127.0.0.1:3000/health || exit 1

WORKDIR /app/backend
CMD ["node", "src/bootstrap.js"]
