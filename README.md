# ClassTrans Pro · 课堂实时翻译

ClassTrans Pro 是一款面向课堂 / 会议场景的**实时语音识别与翻译**Web 应用：实时采集麦克风与系统（标签页）音频，将外语语音边说边转写为原文，并同步给出译文，自动整理成可回看、可润色、可生成摘要的课堂记录。

> **技术定位：** React 19 单页应用 + Supabase（认证与数据）+ Cloudflare（Pages / Functions / Worker）+ 阿里云百炼 DashScope（实时语音与大模型）的全栈 Serverless 项目。

---

## ✨ 核心功能

- **实时语音转写 + 翻译**：边说边出原文与译文，低延迟流式更新。
- **双音源采集**：支持麦克风与系统/标签页音频，适配线下与线上（网课、会议）场景。
- **会话记录与回看**：自动按发言轮次聚合成对话气泡，云端保存，跨设备同步。
- **AI 润色与摘要**：基于大模型对转写文本做润色，并一键生成课堂摘要。
- **个人术语表（Glossary）**：自定义专有名词，提升识别与翻译准确度。
- **文件夹管理**：按课程 / 主题组织会话，云端文件夹结构。
- **账号体系**：Supabase 邮箱登录、密码重置，数据按用户隔离（行级安全 RLS）。

## 🛠 技术栈

| 层 | 技术 |
|----|------|
| 前端 | React 19、React Router 7、Tailwind CSS、lucide-react、Create React App |
| 认证与数据 | Supabase（PostgreSQL + Auth，ES256/RS256 JWT，Row Level Security） |
| 边缘后端 | Cloudflare Pages Functions（`/api/*`，校验 JWT 后调用大模型） |
| 实时中继 | Cloudflare Worker（WebSocket 透传中继，隐藏 API Key、保活心跳） |
| 语音 / 大模型 | 阿里云百炼 DashScope —— Qwen LiveTranslate（实时一遍式语音翻译）、Paraformer（两段式备选）、Qwen 大模型（润色 / 摘要） |

## 🏗 系统架构

```
                     ┌──────────────────────────────────────┐
                     │   浏览器 (React SPA, Cloudflare Pages) │
                     │   麦克风 / 系统音频采集 → PCM 流        │
                     └───────┬───────────────┬───────────────┘
                             │               │
              HTTPS (REST)   │               │  WebSocket (音频上行 / 文本下行)
                             ▼               ▼
        ┌───────────────────────────┐   ┌──────────────────────────────┐
        │ Cloudflare Pages Functions│   │   Cloudflare Worker（中继）    │
        │  /api/polish 润色         │   │  /realtime → Qwen LiveTranslate│
        │  /api/summary 摘要        │   │  /asr      → Paraformer（备选）│
        │  /api/asr-vocabulary 术语 │   │  注入鉴权头 + 心跳保活          │
        │  （校验 Supabase JWT）    │   └───────────────┬──────────────┘
        └─────────────┬─────────────┘                   │
                      │                                  ▼
                      │                    ┌──────────────────────────┐
                      ├───────────────────▶│  阿里云百炼 DashScope      │
                      │   大模型调用         │  实时语音 ASR + 翻译        │
                      ▼                     │  Qwen 大模型（润色/摘要）   │
        ┌───────────────────────────┐      └──────────────────────────┘
        │  Supabase                 │
        │  Auth + PostgreSQL (RLS)  │
        │  文件夹 / 会话 / 术语 / 设置 │
        └───────────────────────────┘
```

**为什么需要中继 Worker：** DashScope 实时语音接口要求在 WebSocket 上携带 `Authorization` 头，而浏览器无法为 WebSocket 设置该头，且 API Key 不能下放到客户端。Worker 作为纯透传中继注入鉴权头，并每 30s 发送心跳以规避 Cloudflare 对空闲连接约 100s 的超时断开。

**语音管线：** 默认采用 Qwen LiveTranslate（Omni-Realtime 协议）「一遍式」直接输出原文与译文；Paraformer 两段式（先识别后翻译）作为备选方案。各识别会话共享 `BaseAsrSession` 抽象层统一处理传输、重连与容错。

## 📁 目录结构

```
classtrans/
├── src/                      # React 前端
│   ├── App.js                # 主应用：录音、转写、气泡、会话管理
│   ├── baseAsrSession.js     # 语音识别会话抽象基类（传输 / 重连 / 容错）
│   ├── liveTranslateSession.js  # Qwen LiveTranslate 实时翻译会话（默认）
│   ├── paraformerSession.js  # Paraformer 两段式识别会话（备选）
│   ├── asrAudioPlayer.js     # 译文语音播放
│   ├── hooks/                # useCloudFolders / Sessions / Glossary / Settings 等
│   ├── pages/                # 登录、重置密码等页面
│   └── supabaseClient.js     # Supabase 客户端 + 认证
├── functions/api/            # Cloudflare Pages Functions（生产后端）
│   ├── _auth.js              # Supabase JWT 校验（ES256 / RS256 / HS256）
│   ├── polish.js             # 文本润色
│   ├── summary.js            # 课堂摘要
│   └── asr-vocabulary.js     # 术语表热词
├── cloudflare-worker/        # 实时语音 WebSocket 中继 Worker
├── public/                   # 静态资源
└── *.sql                     # Supabase 数据库 / RLS 迁移脚本
```

## 🚀 本地开发

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量
cp .env.example .env        # 填入 Supabase 与中继 Worker 地址

# 3. 启动开发服务器（http://localhost:3000）
npm start
```

其它命令：

```bash
npm test        # 运行测试
npm run build   # 生产构建（输出到 build/）
```

## ⚙️ 环境变量

前端（`.env`，会打包进客户端，均为公开值）：

| 变量 | 说明 |
|------|------|
| `REACT_APP_SUPABASE_URL` | Supabase 项目地址 |
| `REACT_APP_SUPABASE_ANON_KEY` | Supabase 公开 anon key（由 RLS 保护） |
| `REACT_APP_PARAFORMER_WS_URL` | 语音中继 Worker 的 WebSocket 地址 |

服务端密钥（分别配置于 Cloudflare Pages / Worker 后台，**不进入代码**）：

| 变量 | 位置 | 说明 |
|------|------|------|
| `DASHSCOPE_API_KEY` | Pages Functions + Worker | 阿里云百炼 API Key |
| `SUPABASE_JWT_SECRET` / `SUPABASE_URL` | Pages Functions | JWT 校验 |
| `ALLOWED_ORIGINS` | Worker（可选） | 来源白名单 |

## ☁️ 部署

- **前端 + 后端 API**：Cloudflare Pages（`build/` 静态资源 + `functions/api/*` Pages Functions）。
- **语音中继**：独立部署 `cloudflare-worker/`（`wrangler deploy`，用 `wrangler secret put DASHSCOPE_API_KEY` 设置密钥）。
- **数据库**：在 Supabase 执行仓库根目录下的 `*.sql` 迁移脚本初始化表结构与 RLS 策略。

---

> 本项目为个人作品，用于演示全栈 Serverless 实时音频应用的工程实现。
