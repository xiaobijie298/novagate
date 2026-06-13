# NovaGate 公网部署指南

---

## 前置准备

- 一台 VPS（阿里云/腾讯云/阿里云国际等，约 50-100/月）
- 一个域名（如 `novagate.co`，已解析到 VPS IP）
- SSH 访问 VPS

---

## 方式一：Docker + Nginx + Let's Encrypt（推荐）

### 1. 上传项目到 VPS

```bash
# 在本地打包
cd thai-ai-gateway
tar czf novagate.tar.gz --exclude=node_modules --exclude=.git .

# 上传到 VPS
scp novagate.tar.gz root@你的VPS-IP:/app/
scp .env root@你的VPS-IP:/app/
```

### 2. VPS 初始化

```bash
ssh root@你的VPS-IP

# 安装 Docker
curl -fsSL https://get.docker.com | sh
systemctl enable docker --now

# 安装 Nginx + Certbot
apt update && apt install -y nginx certbot python3-certbot-nginx

# 解压项目
mkdir -p /app/novagate
cd /app
tar xzf novagate.tar.gz -C /app/novagate
mv .env /app/novagate/
```

### 3. 构建并启动应用

```bash
cd /app/novagate
docker build -t novagate .
docker run -d -p 3000:3000 --restart always --name novagate novagate
```

### 4. 配置 Nginx HTTPS

```bash
# 复制项目自带 Nginx 配置
cp /app/novagate/nginx-ssl.conf /etc/nginx/sites-available/novagate

# ⚠️ 编辑，把 your-domain.com 替换为你的真实域名
nano /etc/nginx/sites-available/novagate

# 先创建 HTTP 版的临时配置（用于申请证书）
nano /etc/nginx/sites-available/novagate-temp
```

临时配置内容：
```nginx
server {
    listen 80;
    server_name your-domain.com;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
# 启用临时配置
ln -s /etc/nginx/sites-available/novagate-temp /etc/nginx/sites-enabled/novagate
mkdir -p /var/www/certbot
nginx -t && systemctl reload nginx

# 申请 Let's Encrypt 证书
certbot certonly --webroot -w /var/www/certbot -d your-domain.com --agree-tos -m admin@your-domain.com

# 删除临时配置，启用正式 HTTPS 配置
rm /etc/nginx/sites-enabled/novagate
ln -s /etc/nginx/sites-available/novagate /etc/nginx/sites-enabled/novagate
nginx -t && systemctl reload nginx
```

### 5. SSL 自动续期

```bash
# certbot 默认已设置自动续期 timer，验证：
systemctl status certbot.timer

# 手动测试续期：certbot renew --dry-run
```

### 6. 验证

访问 `https://your-domain.com` —— 应看到 NovaGate UI。

---

## Stripe 收款配置

### 1. 注册 Stripe

前往 https://dashboard.stripe.com/register 注册（建议选泰国区域以支持 THB 和 PromptPay）

### 2. 获取密钥

在 Stripe Dashboard → Developers → API keys → 复制 Secret Key

### 3. 配置 Webhook（生产环境）

Stripe Dashboard → Webhooks → Add endpoint：
- URL: `https://your-domain.com/api/stripe/webhook`
- Events: `checkout.session.completed`
- 复制 Signing Secret

### 4. 本地测试 Webhook（开发环境）

```bash
# 安装 Stripe CLI: https://stripe.com/docs/stripe-cli
stripe login
stripe listen --forward-to localhost:3000/api/stripe/webhook
# 终端会输出 webhook signing secret，填入 .env 的 STRIPE_WEBHOOK_SECRET
```

### 5. 填入密钥

编辑 `.env`：
```env
STRIPE_SECRET_KEY=sk_live_xxxxxxxxxxxxx
STRIPE_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxx
```

重启服务：
```bash
docker restart novagate
```

---

## 方式二：Railway（0 元起步，最简单）

Railway 自动检测 Node.js 项目，$5 免费额度足够测试。

### 第一步：安装 Railway CLI

```bash
npm install -g @railway/cli
```

### 第二步：登录并部署

```bash
cd thai-ai-gateway

# 登录（会打开浏览器）
railway login

# 新建项目并关联
railway init

# 🔑 设置环境变量（必须！）
railway variables set QWEN_API_KEY=sk-你的真实key
railway variables set PORT=3000

# 🚀 部署
railway up
```

部署成功后会输出 `https://xxxxx.up.railway.app`，这就是你的公网地址，HTTPS 自动配好。

### 第三步：确保公网可访问

Railway Dashboard → 你的项目 → Settings → Networking → 点击 `Generate Domain`

### 第四步（可选）：绑定自定义域名

Railway Dashboard → Settings → Custom Domain → 填入你的域名 → 按提示添加 CNAME 记录

### ⚠️ 免费版存储限制

免费版重启后 `users.json` 和 `logs.json` 会丢失。正式商用升级到 Hobby（$5/月）并加 Volume：

```bash
railway volume add mydata --mount-path /app/data
```

然后改 `server.js` 中 `USERS_FILE` 和 `LOGS_FILE` 路径到 `/app/data/`。

---

## 方式三：Render（免费额度，不用装 CLI）

### 第一步：推送到 GitHub

```bash
cd thai-ai-gateway

# 创建 .gitignore
echo "node_modules/
.env
users.json
logs.json" > .gitignore

# 初始化仓库并推送
git init
git add .
git commit -m "NovaGate MVP"
```

推送到 GitHub（需要先在 github.com 创建仓库）。

### 第二步：在 Render 创建服务

1. 打开 https://dashboard.render.com → 注册（用 GitHub 账号最快）
2. 右上角 `New` → `Web Service`
3. 连接你的 GitHub 仓库
4. 填写：

| 配置项 | 填入 |
|---|---|
| Name | `novagate` |
| Runtime | `Node` |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Instance Type | `Free` ✅ |

5. 点击 `Advanced` → `Add Environment Variable`：

| Key | Value |
|---|---|
| `QWEN_API_KEY` | `sk-你的真实key` |
| `PORT` | `3000` |

6. 点 `Deploy Web Service`

等待 2-3 分钟，访问 `https://novagate.onrender.com`。

### ⚠️ 免费版注意事项

- **15 分钟无请求会休眠** — 下次访问 30-60 秒才醒来
- 防止休眠：用 [UptimeRobot](https://uptimerobot.com) 每 10 分钟 ping 一次
- 存储是临时的，重启后 `users.json` 丢失
- 每月 750 小时免费（刚好 1 个实例跑满）

---

## 三种部署方式对比

| | Railway | Render | VPS+Docker |
|---|---|---|---|
| 价格 | $5 免费额度 | 750h/月免费 | ≈¥50/月 |
| 难度 | ⭐ | ⭐⭐ | ⭐⭐⭐ |
| HTTPS | 自动 | 自动 | 手动配置 |
| 持久存储 | Hobby $5/月 | Disk $1/月 | 自带 |
| 休眠 | 无 | 15分钟 | 无 |
| 域名 | `xxx.up.railway.app` | `xxx.onrender.com` | 自定义 |
| 适合 | 测试/MVP | 测试/MVP | 正式商用 |

---

## 方式四：阿里云 ECS + 宝塔面板

1. ECS 装宝塔面板，一键安装 Nginx + SSL
2. 在宝塔面板 → 网站 → 添加站点 → SSL 选 Let's Encrypt
3. 反向代理 → 目标 URL `http://127.0.0.1:3000`
4. Docker 部署同上

---

## 定价说明

| Plan | 泰语名 | 价格(THB) | Token 数 | 适用 |
|---|---|---|---|---|
| Basic | เบสิก | ฿999 | 10M | 个人小商家 |
| Pro | โปร | ฿2,999 | 50M | 中型店铺 |
| Business | บิซิเนส | ฿9,999 | 200M | 大型商家 |

---

## 安全清单

- [ ] `.env` 中的 API Key 不暴露到 Git
- [ ] Admin 端点加密码保护或 IP 白名单
- [ ] SSL 证书已配置且自动续期
- [ ] Stripe Webhook Secret 已配置
- [ ] 防火墙仅开放 80/443/22 端口
- [ ] Docker 容器使用非 root 用户运行
