# Meta social report

输入一个日期范围，导出 Facebook、Instagram 和 Meta Ads 的统一 CSV / JSON 报表。自然流量与广告流量会分列，Total Views 为两者之和；Reach 不跨渠道去重。

## 导出报表

先完成一次 Meta 连接和资产选择，然后运行：

```bash
npm run report -- --from 2026-09-01 --to 2026-09-20
```

结果保存在 `reports/`，包括可直接用 Excel 打开的 CSV 和包含时间范围、提示信息的 JSON。程序自动比较前一个等长周期来计算 WoW。

Meta 没有向所有账号开放所有原生洞察字段时，报表会保留空白而不是估算或编造数字，并在终端提示原因。

## 网络连接

本机需要能访问 `graph.facebook.com`。如果使用代理，在 `.env` 新增 `HTTPS_PROXY=http://127.0.0.1:代理端口`；启动和导出命令会自动使用这个代理。

## Start locally

1. Copy `.env.example` to `.env` and enter the app secret locally. The Meta login configuration ID is already set.
2. In the Meta app, add the exact callback URL from `META_REDIRECT_URI` to the Facebook Login configuration.
3. Run `npm start`, open `http://localhost:8787`, then choose **Connect Meta**.
4. Select the managed Facebook Page and linked Instagram professional account. The first sync begins immediately and repeats every day.

The dashboard stores tokens only in `data/store.json` on the server; it never exposes them to the browser. Before deploying, replace the local callback URL with the HTTPS production URL and use a managed secret store.

## Reporting logic

- Organic views and Ads views are stored separately; Total Views is their sum.
- Total Reach is intentionally not deduplicated across content or paid delivery.
- Engagement rate is interactions ÷ reach.
- Net follow growth is follows gained − follows lost.
- WoW is blank when the comparison week is zero.
