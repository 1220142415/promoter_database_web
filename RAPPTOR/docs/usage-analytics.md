# 访问统计

## 启用与访问

`RAPPTOR_ANALYTICS=on` 启用采集。`RAPPTOR_ANALYTICS_PRECISION=city` 增加城市、区域
和坐标；未设置时仅采集国家级信息。生产配置以 `wrangler.toml` 为准。
数据库准备步骤见 [部署手册](cloudflare-workers-builds.md)，统计表由迁移 `0005` 创建。

后台 `/admin/usage` 和接口 `/api/admin/usage` 使用 HTTP Basic Auth。
设置以下 Worker Secrets 后才能访问；缺失时返回 404：

```bash
npx wrangler secret put RAPPTOR_ANALYTICS_USERNAME
npx wrangler secret put RAPPTOR_ANALYTICS_PASSWORD
```

`RAPPTOR_USAGE_PUBLIC_PAGE=on` 公开 `/usage` 汇总报表。公开页不提供原始地址或
CSV/JSON 导出。采集开关与报告访问开关独立。

## 统计口径

- 记录完整页面加载，排除 API、Range、静态资源、预取、统计页和已知爬虫。
- 不将客户端路由的 RSC 请求计为页面加载，以免与预取重复。
- Cloudflare 的地理字段来自 `request.cf`，汇总写入在响应后的后台任务中执行。
- 统计表不保存原始 IP 或 User-Agent；以每日随机盐生成的 token 近似去重访客。
  同一地址与 User-Agent 一天计一次，多日访客数为各日计数之和。
- 每日 Cron 清理过期汇总和旧盐；默认保留 400 天。认证会话的元数据另由 Better Auth 管理。

## 报告接口与配置

`/api/admin/usage` 默认返回 JSON。CSV 使用
`?format=csv&dataset=countries|cities|paths|daily`，选择其中一个 dataset。
后台支持国家、城市、页面和日趋势，以及 7 天至全部历史的时间范围。

| 变量 | 作用 |
| --- | --- |
| `RAPPTOR_ANALYTICS` | `on` 启用采集 |
| `RAPPTOR_ANALYTICS_PRECISION` | `city` 增加城市信息，否则仅国家 |
| `RAPPTOR_USAGE_PUBLIC_PAGE` | `on` 公开只读报告 |
| `RAPPTOR_ANALYTICS_RETENTION_DAYS` | 保留天数，默认 400 |
| `RAPPTOR_ANALYTICS_TRUST_PROXY_HEADERS` | 非 Cloudflare 部署的可信代理头开关 |

非 Cloudflare 部署默认忽略转发的地址和地理头。只有受控代理会覆盖这些头时，
才启用 `RAPPTOR_ANALYTICS_TRUST_PROXY_HEADERS=on`。
地图数据由 `npm run analytics:map` 从 Natural Earth 1:110m 生成，产物为
`src/generated/world-map.json`，页面使用服务端 SVG。
