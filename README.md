# Temu Playwright Monitor

本目录是一套本机 Temu 广告后台巡检脚本。

## 项目关键知识

这套项目的稳定运行依赖本机 Chrome 登录态。浏览器控制方式是 **Playwright over CDP**：脚本通过 Playwright API 连接普通 Chrome 的 remote debugging port，复用独立 Chrome profile、已保存密码和登录 cookie。不要把登录改成纯 API；Temu 登录涉及短信、验证码、设备风控和动态请求头，推荐继续用 `npm run temu:login:cdp` 建立/修复登录态。

产品广告报表现在是 **API 优先**：

- Codex 定时入口和 legacy wrapper 默认设置 `TEMU_PRODUCT_SOURCE=api`
- API 切店使用 `POST /api/v1/coconut/account/mall_list?mallType=2` 和 `POST /api/v1/coconut/account/mall_switch?mallType=2&targetMallId=...`
- 商品报表使用 `POST /api/v1/coconut/reports/queryReports` 和 `POST /api/v1/coconut/ad/ads_report`
- `today` 和 `yesterday` 都使用 `time_type=1`，靠上海时区的 start/end 时间戳控制日期；不要改成 `time_type=2`
- `TEMU_API_DOM_FALLBACK=0` 可关闭 DOM 兜底，用于验证接口路径是否真的可用
- 需要临时回退旧页面采集时，设置 `TEMU_PRODUCT_SOURCE=dom`

出库单异常巡店仍是页面自动化，入口是 `scripts/temu-abnormal-orders.mjs`。它从 `https://agentseller.temu.com/lgst/auth-warehouse/abnormal-order` 启动，逐店校验当前店铺名、异常数量和底部总数。若触发短信或验证码，需要在对应 CDP Chrome profile 里人工完成后重跑。

正式交付路径只使用企业微信群机器人 webhook：`WECOM_WEBHOOK_URL`。`npm run temu:report:all:image` 先生成合并 JSON，再生成 780px 宽的紧凑汇总图片，最后按 markdown 标题、图片的顺序发送；不要回退到 `wecom-cli` 文本发送。

核心文件：

- `temu-accounts.json`: 账号、CDP profile、端口、店铺列表和精确店名配置
- `scripts/temu-report.mjs`: 单账号产品广告报表采集，包含 API 采集和 DOM 兜底
- `scripts/temu-run-all.mjs`: 多账号产品广告报表合并
- `scripts/temu-abnormal-orders.mjs`: 出库单异常巡店
- `scripts/temu-summary-image.mjs`: 汇总图片和企业微信群机器人发送
- `scripts/run-codex-temu-report.sh`: Codex 定时任务正式入口
- `temu-reports/`: JSON、图片、debug、Network capture 和审计日志输出目录

排查优先级：

1. 看 `temu-reports/codex.audit.log` 判断 Codex wrapper 是否启动、重试、成功。
2. 看 `temu-reports/codex.err.log` 和 `temu-reports/codex.out.log` 找命令级错误。
3. 看最新 `temu-all-accounts-*.json`，确认 `productSource`、每店 `source`、`failures`、`apiComparison`。
4. 看最新 `temu-abnormal-orders-*.json`，确认异常巡店是否全店成功。
5. 必要时用 `npm run temu:report:api:capture` 或 `npm run temu:report:capture` 生成脱敏 Network 捕获文件。

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

Codex 定时任务使用的正式入口：

```bash
npm run temu:report:codex:today
npm run temu:report:codex:yesterday
```

Codex 入口会加载 `.env.local`、重置两个 CDP 端口、唤醒桌面、用 `caffeinate` 包住采集和发送流程，并把审计日志写入 `temu-reports/codex.audit.log`。产品广告报表默认使用接口切店和接口采集；需要临时回退页面采集时，可在环境变量中设置 `TEMU_PRODUCT_SOURCE=dom`。命令失败时默认会重试一次；如果重试后仍失败，命令会保留非零退出码，让 Codex 自动化继续排查日志、修复脚本并重跑到完成。

汇总图片标题使用 `欧区销量汇总 YYYY-MM-DD HH:mm:ss`，时间取多账号脚本启动时间；副标题显示 `对比日期：上一日 HH:mm:ss`。图片顶部用两张加粗卡片展示总件数和总销售额及上一日百分比变化；下方按店铺分组列出商品图、总花费、净件数、净销售额、曝光量、点击率和转化率。店铺名只显示在小计行，小计行只展示该店铺件数和销售额。图片中的商品明细每个店铺只展示净销售额前 5 且净销售额大于 0 的商品，完整商品明细仍保留在 JSON 中。夜间任务点击 `昨日` 并统计昨日数据，企业微信 markdown 文字口径仍使用昨日汇总。企业微信通过 `WECOM_WEBHOOK_URL` 群机器人 webhook 先发送 markdown 标题，再发送图片。

### 汇总图片和企业微信推送规则

`npm run temu:report:all:image` 是定时任务使用的正式发送入口：

- 先生成所有账号合并 JSON，再用 `scripts/temu-summary-image.mjs` 生成 `780px` 宽的紧凑图片表格
- 图片标题格式为 `欧区销量汇总 YYYY-MM-DD HH:mm:ss`；时间优先取 `temu-all-accounts-*.json` 文件名里的多账号脚本启动时间；`TEMU_REPORT_DATE=yesterday` 时日期会按该启动时间的上海日期减一天
- 图片副标题格式为 `对比日期：上一日 HH:mm:ss`
- 图片顶部用两张加粗卡片显示总件数、总销售额及相对上一日百分比变化
- 商品表按店铺分组；小计行背景加深，只显示店铺名、净件数和净销售额，不显示“小计”字样；商品行列固定为 `商品图`、`总花费`、`净件数`、`净销售额`、`曝光量`、`点击率`、`转化率`，列宽平均分配
- 商品按店铺内净销售额从大到小排序，图片中每个店铺只展示净销售额前 5 且净销售额大于 0 的商品；完整商品明细仍保留在 JSON 中，不因图片截断而裁剪
- 商品图片会下载缓存到 `temu-reports/product-images`
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

接口探针模式只生成本地 Network 捕获 JSON，不发送企业微信，适合定位页面接口：

```bash
npm run temu:report:capture
npm run temu:abnormal:capture
```

捕获文件保存到 `temu-reports/temu-network-capture-*.json`。请求头、查询参数和请求/响应体里的 cookie、token、sign、password 等敏感字段会脱敏。

产品广告数据也可以走页面登录态下的接口采集和接口切店，默认失败时会回退到原页面采集：

```bash
npm run temu:report:api
npm run temu:report:api:capture
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
- `TEMU_PRODUCT_DETAIL_LIMIT`: 图片中每个店铺展示的商品明细数量，默认 `5`；只影响图片，不影响 JSON 完整明细
- `TEMU_PRODUCT_IMAGE_DIR`: 商品图片下载缓存目录，默认 `temu-reports/product-images`
- `TEMU_PRODUCT_IMAGE_FETCH_TIMEOUT_MS`: 单张商品图下载超时时间，默认 `12000`
- `TEMU_CLOSE_CHROME_PAGES=0`: 任务结束后保留 CDP Chrome 标签页，默认会关闭本次专用 profile 下的所有标签页
- `TEMU_CAPTURE_NETWORK=1`: 开启页面接口旁路捕获，写入 `temu-network-capture-*.json`
- `TEMU_CAPTURE_NETWORK_MAX_EVENTS`: 接口捕获最多保存的事件数，默认 `800`
- `TEMU_CAPTURE_NETWORK_MAX_BODY_CHARS`: 单个响应体预览最多保存字符数，默认 `120000`
- `TEMU_PRODUCT_SOURCE=dom|api`: 产品广告数据采集来源；直接运行 `scripts/temu-report.mjs` 默认 `dom`，Codex/legacy wrapper 默认 `api`
- `TEMU_API_DOM_FALLBACK=0`: `TEMU_PRODUCT_SOURCE=api` 时关闭 DOM 兜底，接口失败会直接报错
- `TEMU_REPORT_DATE=today|yesterday`: 选择报表日期按钮，默认 `today`；定时任务在 `00:01` 自动使用 `yesterday`，在 `09:00` 使用 `today`
- `TEMU_CODEX_MAX_ATTEMPTS`: Codex 定时入口的命令级最大尝试次数，默认 `2`
- `TEMU_CODEX_RETRY_DELAY_SECONDS`: Codex 定时入口两次尝试之间的等待秒数，默认 `15`
- `TEMU_CODEX_WAKE_DELAY_SECONDS`: Codex 定时入口唤醒并等待桌面恢复的秒数，默认 `25`
- `TEMU_CODEX_WAKE_DISPLAY=0`: 关闭 Codex 定时入口的显示器唤醒等待，通常只在调试 wrapper 时使用
- `TEMU_LAUNCHD_WAKE_DELAY_SECONDS`: launchd 定时入口唤醒并等待桌面恢复的秒数，默认 `25`
- `TEMU_LAUNCHD_WAKE_DISPLAY=0`: 关闭 launchd 定时入口的显示器唤醒等待，通常只在调试 wrapper 时使用
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

当前 Codex 定时策略：

- `00:01`：自动点击 `昨日`，汇总并推送昨日数据，标题使用 `昨日汇总`
- `09:00`：自动点击 `今日`，汇总并推送今日数据

Codex 自动化会调用 `npm run temu:report:codex:yesterday` 和 `npm run temu:report:codex:today`。入口 `/Users/vure/ReportDalily/scripts/run-codex-temu-report.sh` 会先用 `caffeinate -u` 声明用户活跃并等待桌面恢复，再用 `caffeinate -d -i -m` 包住整次采集。产品广告数据默认走 `TEMU_PRODUCT_SOURCE=api`，从页面登录态调用 Temu 接口切店和拉取报表；出库单异常巡店仍走现有页面逻辑。需要调试旧路径时，可临时设置 `TEMU_PRODUCT_SOURCE=dom`。

历史 launchd 入口 `/Users/vure/ReportDalily/scripts/run-temu-report-all.sh` 保留为手动备用，不再作为当前定时源，避免和 Codex 自动化重复发送。

日报、异常巡店和 CDP 登录脚本结束时会默认关闭对应 CDP 专用 profile 下的 Chrome 标签页，避免残留页面影响后续自动化任务。需要调试保留页面时，可临时加 `TEMU_CLOSE_CHROME_PAGES=0`。

企业微信webhook开发文档: https://developer.work.weixin.qq.com/document/path/99110
