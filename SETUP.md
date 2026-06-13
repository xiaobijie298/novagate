# 泰国电商 AI 代理网关 — MVP 设置指南

## 第一步：开通通义千问 API Key

1. 访问阿里云 DashScope 控制台：https://dashscope.aliyun.com/
2. 用阿里云账号登录（没有就先注册，需要实名认证）
3. 进入「API Key 管理」→「创建 API Key」
4. 复制生成的 Key（格式类似 `sk-xxxxxxxxxxxx`）
5. 将 Key 填入本目录下的 `.env` 文件中：
   ```
   QWEN_API_KEY=sk-你的真实key
   ```

⚠️ 新账号通常有**免费额度**，先用来测试，不够再充值。

---

## 第二步：安装依赖

在项目目录下运行（用 WorkBuddy 内置终端或你自己的终端）：

```bash
cd "C:\Users\29849\WorkBuddy\thai-ai-gateway"
npm install
```

---

## 第三步：启动服务

```bash
npm start
```

启动成功后会看到：
```
Thai AI Gateway MVP running on http://localhost:3000
```

---

## 第四步：创建用户（获取 Token）

服务启动后，**另开一个终端**，运行：

```bash
# 创建用户（返回 token，妥善保存！）
curl -X POST http://localhost:3000/admin/create-user -H "Content-Type: application/json" -d "{\"quota\":100000}"

# 查看所有用户
curl http://localhost:3000/admin/users

# 给用户充值（token 替换为上一步返回的）
curl -X POST http://localhost:3000/admin/topup -H "Content-Type: application/json" -d "{\"token\":\"sk_xxx\",\"quota\":50000}"
```

---

## 第五步：打开 UI 测试

浏览器访问：http://localhost:3000/

1. 把上一步获得的 token 粘贴到「API Token」输入框
2. 填写商品名称，选择语言（推荐泰语）
3. 点击「生成商品描述」

---

## API 端点说明

| 端点 | 方法 | 说明 |
|------|------|------|
| `/admin/create-user` | POST | 创建用户，返回 token |
| `/admin/users` | GET | 查看所有用户额度 |
| `/admin/topup` | POST | 给用户充值 |
| `/api/chat` | POST | 通用对话（透传通义千问） |
| `/api/gen-product-desc` | POST | 泰语商品描述生成 |

---

## 下一步可扩展方向

- [ ] 接入 Stripe / PromptPay 实现自动扣费
- [ ] 增加 LINE Bot 接口
- [ ] 增加 Shopee 商品批量上传功能
- [ ] 用 Tauri 打包成桌面应用
- [ ] 增加多模型切换（DeepSeek、智谱等）
