# Temu Playwright Monitor

本目录是一套本机 Temu 广告后台巡检脚本。

## 首次登录

```bash
npm run temu:login:cdp
```

脚本会用普通 Chrome 打开一个 CDP 专用 profile：

```text
/Users/vure/ReportDalily/temu-chrome-cdp-profile
```

在打开的 Chrome 窗口中登录 Temu 并完成短信验证，然后回到终端按 Enter。

如果要登录第二个账号，使用独立 profile 和端口，避免覆盖第一个账号：

```bash
TEMU_CDP_PROFILE_DIR=/Users/vure/ReportDalily/temu-chrome-cdp-profile-account2 \
TEMU_CDP_PORT=9223 \
npm run temu:login:cdp
```

## 运行巡检

两套账号一起巡检：

```bash
npm run temu:report:all
```

两套账号一起巡检，并通过企业微信群机器人发送 markdown 标题和紧凑汇总图片：

```bash
npm run temu:report:all:image
```

汇总图片标题使用 `欧区销量汇总 YYYY-MM-DD`，其中日期是本次报表实际统计的销售日期；副标题固定显示 `对比日期为上一日`；图片内每个店铺和合计行展示件数、销售额相对上一日同时间附近报告的涨跌百分比。夜间任务点击 `昨日` 并统计昨日数据，企业微信 markdown 文字口径仍使用昨日汇总。企业微信通过 `WECOM_WEBHOOK_URL` 群机器人 webhook 先发送 markdown 标题，再发送图片。

### 汇总图片和企业微信推送规则

`npm run temu:report:all:image` 是定时任务使用的正式发送入口：

- 先生成所有账号合并 JSON，再用 `scripts/temu-summary-image.mjs` 生成 `780px` 宽的紧凑图片表格
- 图片标题格式为 `欧区销量汇总 YYYY-MM-DD`；`TEMU_REPORT_DATE=yesterday` 时日期会按生成时间的上海日期减一天
- 图片副标题固定为 `对比日期为上一日`
- 表格列固定为 `店铺`、`件数`、`销售额`，最后一行是 `合计`
- 每个店铺行和合计行都在 `件数`、`销售额` 下方显示相对上一日的百分比变化
- 对比基准自动选择“上一日、报告更新时间最接近当前报告时间”的 `temu-all-accounts-*.json`
- 对比基准会优先选择相同 `TEMU_REPORT_DATE` 口径的历史报告，避免 `昨日` 报告误用 `今日` 报告做环比
- 正增长使用绿色上三角，负增长使用红色下三角，无变化或缺少基准使用灰色提示
- 企业微信只通过 `WECOM_WEBHOOK_URL` 群机器人 webhook 发送，不使用 `wecom-cli`；发送顺序为 markdown 标题，然后发送图片
- `TEMU_REPORT_DATE=today` 时，发送前会先执行出库单异常巡店，并把异常摘要追加到 markdown 文字消息；全部为 0 时显示 `今日出库单异常0条。`，否则逐店显示异常条数

账号、Chrome profile、端口和店铺列表配置在：

```text
/Users/vure/ReportDalily/temu-accounts.json
```

单账号巡检：

```bash
npm run temu:report
```

出库单及异常处理巡店，只生成 JSON，不发送企业微信：

```bash
npm run temu:abnormal
```

只跑指定账号组，例如第二组 `Whitine / LEEEV`：

```bash
TEMU_ACCOUNT_ID=whitine-leeev npm run temu:abnormal
```

异常巡店会直接从 `https://agentseller.temu.com/lgst/auth-warehouse/abnormal-order` 启动，被重定向时再处理登录/授权；每个店铺切换后先校验当前店铺名称，再读取 `异常` 数量，并用底部 `共有 N 条` 做校验。若店铺无权限访问该异常页，JSON 会记录为无权限而不是误报 0 条；若触发短信或验证码，需要在对应 CDP Chrome profile 中完成验证后重跑。

巡检会自动：

- 打开 Temu 广告后台
- 登录态失效时点击右上角登录，选择非当地卖家，并优先使用 Chrome 保存密码自动登录
- 登录后先确认当前店铺名；不匹配时先切换到目标店铺
- 切换到欧区
- 进入数据报表
- 打开商品数据报表
- 按 `TEMU_REPORT_DATE` 强制点击 `今日` 或 `昨日`，并验证对应筛选处于选中状态
- 按净申报价销售额（全店）降序排序；若店铺没有净销售额列，则回退到申报价销售额（全店）
- 验证排序表头的下三角为蓝色，同时验证表格数据为从高到低
- `npm run temu:report:all` 只生成所有账号的合并 JSON
- `npm run temu:report:all:image` 生成紧凑汇总图片，并通过企业微信群机器人 webhook 发送 markdown 标题和图片

输出文件会保存到：

```text
/Users/vure/ReportDalily/temu-reports
```

## 可配置环境变量

- `TEMU_PROFILE_DIR`: 覆盖 Playwright 专用 profile 目录
- `TEMU_CDP_PROFILE_DIR`: 覆盖普通 Chrome CDP profile 目录
- `TEMU_CDP_PORT`: 覆盖 CDP 端口，默认 `9222`
- `TEMU_REPORT_DIR`: 覆盖报告输出目录
- `WECOM_WEBHOOK_URL`: 企业微信群机器人 webhook 地址；企业微信图片推送必须配置
- `TEMU_SEND_WECOM=0`: 生成汇总图片时跳过企业微信群发送，适合测试
- `TEMU_CLOSE_CHROME_PAGES=0`: 任务结束后保留 CDP Chrome 标签页，默认会关闭本次专用 profile 下的所有标签页
- `TEMU_REPORT_DATE=today|yesterday`: 选择报表日期按钮，默认 `today`；定时任务在 `00:01` 自动使用 `yesterday`，在 `09:00` 使用 `today`
- `TEMU_SHOPS`: 覆盖巡检店铺列表，默认 `SETONR Products,SETONR Origin`
- `TEMU_KNOWN_SHOPS`: 只用于识别当前店铺和打开切换器，适合当前店铺不在巡检列表时使用
- `TEMU_LOGIN_ACCOUNT`: 登录态失效时自动登录用的手机号或邮箱，不建议写入文件
- `TEMU_LOGIN_PASSWORD`: 登录态失效时自动登录用的密码，不建议写入文件
- `TEMU_AUTO_LOGIN=0`: 关闭自动登录，只复用现有登录态
- `TEMU_ACCOUNTS_CONFIG`: 覆盖多账号配置文件，默认 `temu-accounts.json`

第二个账号巡检时同样带上独立 profile 和端口；如果店铺名不同，再加 `TEMU_SHOPS`：

```bash
TEMU_CDP_PROFILE_DIR=/Users/vure/ReportDalily/temu-chrome-cdp-profile-account2 \
TEMU_CDP_PORT=9223 \
TEMU_KNOWN_SHOPS="Whitine Products,Whitine Products Global,LEEEV Global Outlet,LEEEV,LEEEV Selected" \
TEMU_SHOPS="Whitine Products Global,LEEEV Global Outlet,LEEEV" \
npm run temu:report
```

## 备注

`npm run temu:login` 是 Playwright persistent profile 方案。Temu 如果拦截自动化浏览器登录，优先使用 `npm run temu:login:cdp`。

店铺名使用精确匹配，不做模糊匹配。例如 `Whitine Products` 和 `Whitine Products Global` 会被视为两个不同店铺。区域切换控件缺失会直接报错，因为正确店铺应当显示该控件。

当前 launchd 定时策略：

- `00:01`：自动点击 `昨日`，汇总并推送昨日数据，标题使用 `昨日汇总`
- `09:00`：自动点击 `今日`，汇总并推送今日数据

日报、异常巡店和 CDP 登录脚本结束时会默认关闭对应 CDP 专用 profile 下的 Chrome 标签页，避免残留页面影响后续自动化任务。需要调试保留页面时，可临时加 `TEMU_CLOSE_CHROME_PAGES=0`。

企业微信webhook开发文档: https://developer.work.weixin.qq.com/document/path/99110
