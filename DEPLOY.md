# 吟游手册 - 部署指南

## 方案一：Vercel 免费部署（推荐）

免费、自动 HTTPS、全球 CDN、零运维。

### 部署步骤

1. 将代码推送到 GitHub（或 GitLab / Bitbucket）

2. 打开 [vercel.com/new](https://vercel.com/new)，导入你的仓库

3. Vercel 会自动检测配置，直接点 **Deploy** 即可

4. 部署完成后会给你一个 `xxx.vercel.app` 域名，分享给别人即可使用

### 代码更新

每次 push 到 GitHub 主分支，Vercel 会自动重新部署，无需手动操作。

### 绑定自定义域名（可选）

在 Vercel 项目设置 → Domains 中添加你的域名，按提示配置 DNS 即可。

### 免费额度

- 无限静态请求
- Serverless 函数调用：100GB-hours/月
- 单次函数执行最长 60 秒
- 自动 HTTPS
- 全球 CDN

---

## 方案二：Docker 部署

### 前提条件
- 服务器安装 Docker 和 Docker Compose

### 部署步骤

1. 将项目上传到服务器

2. 构建并启动：
```bash
docker compose up -d --build
```

3. 访问 `http://你的服务器IP:3001`

### 常用命令
```bash
# 查看日志
docker compose logs -f

# 停止服务
docker compose down

# 重新构建（代码更新后）
docker compose up -d --build
```

---

## 方案三：直接部署

### 前提条件
- 服务器安装 Node.js 18+

### 部署步骤

1. 上传项目到服务器

2. 安装依赖并构建：
```bash
npm ci
npx vite build
```

3. 启动服务：
```bash
# 前台运行
npm start

# 或使用 PM2 后台运行（推荐）
npm install -g pm2
pm2 start server/index.js --name tavern-helper
pm2 save
pm2 startup
```

4. 访问 `http://你的服务器IP:3001`

---

## 方案四：Nginx 反向代理 + HTTPS

适合有域名的场景：

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;

        # SSE 流式传输必须关闭缓冲
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
    }
}
```

---

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| PORT | 3001 | 服务端口 |
| HOST | 0.0.0.0 | 监听地址 |
| CORS_ORIGINS | (允许全部) | 允许的域名，逗号分隔 |
| PROXY_ACCESS_TOKEN | (未设置，不启用) | 可选的代理访问令牌。设置后，所有 `/api/ai/*` 请求必须携带请求头 `X-Proxy-Token: <令牌值>`，否则返回 401；未设置时不做任何校验。Cloudflare Workers 部署用 `npx wrangler secret put PROXY_ACCESS_TOKEN` 设置 |
| PROXY_BLOCK_LOOPBACK | (未设置，回环放行) | 是否连回环地址（localhost / 127.0.0.1 / ::1）也禁止代理。本地自托管保持默认——连接本机模型（Oobabooga/KoboldCPP）是内置用例；**公网部署建议设为 1**。其它内网段与云元数据地址无论如何设置都始终拦截 |

---

## 注意事项

1. **数据存储在浏览器**：用户数据保存在各自浏览器的 IndexedDB 中，不同设备/浏览器之间数据不互通
2. **API Key 由用户提供**：服务器只做 CORS 代理转发，不存储任何 API Key
3. **HTTPS 建议**：Vercel 自带 HTTPS；自建服务器建议配置 SSL
4. **公网部署安全**：AI 代理内置了 SSRF 防护（拒绝转发到内网/云元数据地址，且对上游 3xx 重定向的每一跳重新校验）和 2MB 请求体上限（流式读取，超限即中止）。回环地址默认放行以支持本机模型，公网部署建议设置 `PROXY_BLOCK_LOOPBACK=1` 一并拦截。代理默认无鉴权，公网部署时任何人都可借用你的服务器中转 AI 请求——建议设置 `PROXY_ACCESS_TOKEN` 启用访问令牌，调用方需在请求头携带 `X-Proxy-Token`。注意：前端界面暂未提供令牌配置入口（支持将另行跟进），当前启用令牌后需由调用方自行携带该头，或通过反向代理（如 Nginx `proxy_set_header X-Proxy-Token`）注入
