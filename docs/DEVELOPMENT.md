# 本地开发环境

## 固定版本

- Node.js `24.18.1`，由根目录 `.nvmrc` 固定；
- pnpm `11.20.0`，由根目录 `package.json` 固定；
- PostgreSQL `18` 与 pgvector `0.8.5`，由根目录 `compose.yaml` 固定。

## 前置条件

- nvm；
- Docker Engine 与 Docker Compose；
- 当前稳定版 Google Chrome；Microsoft Edge 在发布验收前安装即可。

## 初始化

```bash
nvm use
corepack enable
pnpm install --frozen-lockfile
```

## 数据库

启动数据库：

```bash
docker compose up -d postgres
docker compose ps
```

停止数据库：

```bash
docker compose down
```

默认数据库只绑定到本机回环地址 `127.0.0.1:5432`。默认凭据仅供本地开发使用；远程部署必须通过环境变量覆盖，并遵循产品的外部认证与网络访问控制要求。

## 容器化运行整套应用

复制并按需修改环境变量后构建、启动：

```bash
cp .env.example .env
docker compose up --build -d
docker compose ps
```

浏览器访问 <http://127.0.0.1:18080>。API 容器启动时会自动执行尚未应用的数据库迁移。

停止应用：

```bash
docker compose down
```

生产或远程部署前，必须修改 `POSTGRES_PASSWORD` 与 `MODEL_CONFIG_ENCRYPTION_KEY`，并在应用前方配置认证和 TLS。
