# GitHub Actions 自动部署

普通分支和 `main` 的代码推送不会触发部署。只有向 GitHub 推送一个新的、严格递增的 `vMAJOR.MINOR.PATCH` 发布标签后，工作流才会按以下顺序执行：

1. 校验发布标签是新建的三段版本、版本高于所有既有发布标签，并且指向 `main` 上的提交；
2. 类型检查、启动临时 PostgreSQL、执行迁移并运行 Vitest；
3. 构建 `linux/amd64` 的 API 和 Web 镜像并推送到 GitHub Container Registry；
4. 通过 SSH 将 Compose 文件和部署脚本传到服务器；
5. 备份服务器 PostgreSQL，启动新 API 并自动迁移，健康后再切换 Web。

PostgreSQL 镜像不会被构建或推送，服务器现有的 `postgres-data` 卷会继续使用。

## 1. 准备服务器

服务器需要安装 Docker Engine 和 Docker Compose v2。建议使用专门的部署用户，并让该用户具有以下权限：

- 可通过 SSH 密钥登录；
- 可执行 `docker`；
- 可读写部署目录及其中的 `.env`、`backups/` 和 `deploy/`。

`DEPLOY_PATH` 必须指向当前运行 Knowledge 的目录，例如 `/root/knowledge`。不要为了自动部署随意换目录；Compose 项目固定为 `knowledge`，部署前仍应确认现有数据库卷名属于该项目。

部署目录中必须保留生产 `.env`，工作流不会上传或覆盖它。至少确认以下值已经换成生产配置：

```dotenv
POSTGRES_DB=knowledge
POSTGRES_USER=knowledge
POSTGRES_PASSWORD=replace-with-a-strong-password
MODEL_CONFIG_ENCRYPTION_KEY=replace-with-a-long-random-secret
```

如果 GHCR 包是私有的，需要以部署用户在服务器上登录一次。创建具有 `read:packages` 权限的 classic PAT 后执行：

```bash
echo "$CR_PAT" | docker login ghcr.io -u YOUR_GITHUB_USER --password-stdin
```

登录信息保存在该部署用户的 Docker 配置中，不要把 PAT 写入仓库或 `.env`。

## 2. 配置 production Environment

在 GitHub 仓库的 `Settings > Environments` 新建 `production`，添加以下 Environment secrets：

| Secret | 内容 |
| --- | --- |
| `DEPLOY_HOST` | 服务器域名或 IP |
| `DEPLOY_USER` | SSH 部署用户名 |
| `DEPLOY_SSH_KEY` | 对应私钥的完整内容 |
| `DEPLOY_KNOWN_HOSTS` | 已核验的服务器 SSH host key 行 |

添加以下 Environment variables：

| Variable | 内容 |
| --- | --- |
| `DEPLOY_PATH` | 现有部署目录的绝对路径，如 `/root/knowledge` |
| `DEPLOY_PORT` | SSH 端口；不配置时默认为 `22` |

也可以在仓库的 `Settings > Secrets and variables > Actions` 中创建同名的仓库级 Secrets 和 Variables；工作流会直接读取它们。`DEPLOY_PATH` 必须配置，`DEPLOY_PORT` 可以省略并使用默认值 `22`。

可以从可信机器生成 `DEPLOY_KNOWN_HOSTS` 的候选内容：

```bash
ssh-keyscan -p 22 your-server.example.com
```

保存前应通过服务器控制台或云厂商页面核对指纹。工作流启用了严格 host key 校验，不会自动信任陌生主机。

如需每次部署前人工确认，可给 `production` Environment 增加 required reviewers。

## 3. 发布版本

先确保准备发布的提交已经位于 `main`，再创建并推送带注释的版本标签：

```bash
git switch main
git pull --ff-only
git tag -a v0.1.0 -m "Release v0.1.0"
git push origin v0.1.0
```

标签必须严格使用 `vMAJOR.MINOR.PATCH`，三个部分都是不带前导零的非负整数。除第一个版本外，新版本必须高于仓库中所有既有的合法发布标签；例如 `v1.3.0` 之后可以发布 `v1.3.1` 或 `v2.0.0`，不能发布 `v1.2.9`。普通 `git push` 不会运行工作流，推送非法或回退版本只会让发布校验失败，不会进入测试、镜像构建或生产部署。

为避免已发布版本被移动、删除后重新使用，建议在仓库 `Settings > Rules > Rulesets` 中为 `v*.*.*` 创建 Tag ruleset，并启用限制更新与限制删除。工作流会拒绝直接更新已有标签；Tag ruleset 进一步保护完整的版本历史。

镜像名称根据 GitHub 仓库 owner 自动生成，并同时发布三个标签：

- `ghcr.io/<owner>/knowledge-api:sha-<commit>`、`vMAJOR.MINOR.PATCH` 与 `latest`；
- `ghcr.io/<owner>/knowledge-web:sha-<commit>`、`vMAJOR.MINOR.PATCH` 与 `latest`。

服务器部署只使用 `sha-<commit>` 标签，避免 `latest` 在发布过程中变化。

## 数据库迁移与失败处理

API 镜像的启动命令会先执行所有尚未应用的迁移，再启动服务。部署脚本只重建一个 API 容器，因此不会并发执行迁移。每次迁移前会在部署目录的 `backups/` 下生成 PostgreSQL custom-format 备份。

如果 API 或 Web 健康检查失败，脚本会把应用镜像恢复为部署前版本。数据库迁移不会自动回滚，因为自动恢复数据库可能覆盖部署期间产生的新数据；需要根据日志和对应备份人工处理。因此，新迁移必须尽量遵循向后兼容的 expand/contract 方式，先增加结构，再在后续版本移除旧结构。

要重新部署某个历史提交，可在服务器部署目录执行：

```bash
./deploy/production.sh \
  ghcr.io/<owner>/knowledge-api:sha-<40-character-commit> \
  ghcr.io/<owner>/knowledge-web:sha-<40-character-commit>
```
