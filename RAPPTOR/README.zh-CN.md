# RAPPTOR 维护入口

RAPPTOR 提供基因组检索、JBrowse 2 浏览、文件下载和在线启动子预测。
生产站点：[rapptor.xulab.science](https://rapptor.xulab.science)。

网页运行在 Cloudflare Workers；D1 保存目录、用户和业务状态，Hugging Face 保存数据文件。
模型推理运行在独立 Docker 服务。邮箱登录使用 Better Auth，邮件由 Resend 发送。

## 本地启动

使用 Node.js 22.18+ 和 npm，在 `RAPPTOR/` 目录执行：

```bash
npm ci
npm run dev
```

打开 [localhost:3000](http://localhost:3000)。生成的 JSON 目录可用于本地检索；
浏览基因组轨道还需要本地 release 文件或远端存储配置。
配置示例见 `.env.local.example`，实际配置写入忽略的 `.env.local`。
本地调用在线模型需要另外配置开发票据，见下表。

## 按任务查文档

| 要做什么 | 从哪里开始 |
| --- | --- |
| 了解组件关系、找到代码 | [架构](docs/architecture.md) |
| 发布网页、配置密钥、排查构建 | [部署](docs/cloudflare-workers-builds.md) |
| 对接基因组目录、提交和查询预测 | [接口](docs/prediction-service.md) |
| 对接验证码、会话、任务邮件 | [邮件系统](docs/email-system-integration.zh-CN.md) |
| 制作、上传、激活数据集 | [数据发布](docs/data-release.md) |
| 配置访问统计和后台报表 | [访问统计](docs/usage-analytics.md) |
| 本地免邮箱调用真实预测 | [本地预测](docs/prediction-local-test.md) |
| 维护 Docker 推理服务 | [服务手册](services/prediction/README.md) |
| 查询旧方案、故障和验收记录 | [历史归档](docs/archive/README.md) |

## 开发检查

```bash
npm run check
npm run build
```

`check` 包含 ESLint、TypeScript 和 Vitest。Cloudflare 构建与部署命令见部署手册。
真实模型验收需要单独运行，操作说明见 [在线验收](docs/prediction-live-acceptance.md)。

## 数据含义

初始 `2026-08-07` 预测 release 包含 1,000 个带版本的 assembly 和
23,405,141 条分数大于 0.9 的 `promoter_peak`。这些数字只描述该 release；
其源文件没有记录 GTDB release 编号。实验 TSS 使用独立 release，启用时在统一
基因组页面展示。预测、NCBI 注释和实验 TSS 是不同证据，不能互相替代。
文件格式、坐标和发布步骤统一放在数据发布手册中。
