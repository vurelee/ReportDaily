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

出库单异常巡店现在也是 **API 优先**，入口是 `scripts/temu-abnormal-orders.mjs`。它仍先从 `https://agentseller.temu.com/lgst/auth-warehouse/abnormal-order` 建立 agentseller 登录/授权态，但逐店数据默认通过 `POST /api/seller/auth/userInfo` 精确取得 `mallId`，再带 `mallid` 请求 `POST /api/bg/cw/order/queryAbnormalOrderSum` 和 `POST /api/bg/cw/order/pageCwNormalOrderShippingInfo`。需要临时回退旧页面切店和页面读取时，设置 `TEMU_ABNORMAL_SOURCE=dom`；需要严格验证 API 路径时，设置 `TEMU_ABNORMAL_API_DOM_FALLBACK=0`。若触发短信或验证码，需要在对应 CDP Chrome profile 里人工完成后重跑。

店铺运营状态入口是 `scripts/temu-operation-status.mjs`。它从 `https://agentseller.temu.com/goods/list` 建立 agentseller 登录/授权态，通过 `POST /api/seller/auth/userInfo` 精确取得 `mallId`，再带 `mallid` 请求 `POST /visage-agent-seller/product/skc/pageQuery`，请求体为 `{"page":1,"pageSize":100}` 并按页拉全量。初版以 `productId` 作为 SPU ID、`productSkcId` 作为 SKC ID，`skcSiteStatus=1` 且 `removeStatus=0` 视为在售，对齐后台商品列表页签的“在售中”口径；经营站点取 `productSemiManaged.bindSites[].siteName`。站点里包含 `德国站` 计入欧区，包含 `英国站` 计入英区，包含 `美国站` 计入美区；每天会和上一份 `temu-operation-status-*.json` 比对，上一份在售 SPU 这次不再在售或缺失时记为下架异常。

调价待办拒绝入口是 `scripts/temu-price-adjust-reject.mjs`。它从 `https://agentseller.temu.com/main/adjust-price-manage/order-price` 建立 agentseller 登录/授权态，精确切到目标店铺后只进入 `待卖家确认` 页签，唯一允许的提交动作是 `批量拒绝`，拒绝原因固定为 `0`。页面对应接口为 `POST /api/kiana/magnus/mms/price-adjust/status-count`、`POST /api/kiana/magnus/mms/price-adjust/page-query` 和 `POST /api/kiana/magnus/mms/price-adjust/batch-review`；拒绝动作的 payload 形状是 `{"batchResult":2,"submitOrders":[调价单id],"rejectReasons":{"调价单id":"0"}}`。不要实现或调用 `batchResult:1`、`批量确认`、`调整` 或任何同意调价路径。

正式交付路径只使用企业微信群机器人 webhook：`WECOM_WEBHOOK_URL`。`npm run temu:report:all:image` 先生成合并 JSON，再生成 780px 宽的紧凑汇总图片；销售汇总按 markdown 标题、图片的顺序发送，随后单独发送店铺运营状态 `markdown_v2` 表格；不要回退到 `wecom-cli` 文本发送。

核心文件：

- `temu-accounts.json`: 账号、CDP profile、端口、店铺列表和精确店名配置
- `scripts/temu-report.mjs`: 单账号产品广告报表采集，包含 API 采集和 DOM 兜底
- `scripts/temu-run-all.mjs`: 多账号产品广告报表合并
- `scripts/temu-report-all-image-flow.mjs`: 正式交付顺序编排；子步骤失败立即停止，并把本轮生成的 JSON 路径显式传给发送脚本
- `scripts/temu-abnormal-orders.mjs`: 出库单异常巡店
- `scripts/temu-price-adjust-reject.mjs`: 调价待办批量拒绝，拒绝原因固定为 `0`
- `scripts/temu-operation-status.mjs`: 店铺运营状态巡店，记录 SPU 在售状态、经营站点和下架异常
- `scripts/temu-summary-image.mjs`: 汇总图片和企业微信群机器人发送
- `scripts/temu-operation-status-markdown.mjs`: 店铺运营状态 `markdown_v2` 表格发送
- `scripts/temu-operation-status-image.mjs`: 店铺运营状态图片表格备用生成脚本
- `scripts/run-codex-temu-report.sh`: Codex 定时任务正式入口
- `temu-reports/`: JSON、图片、debug、Network capture 和审计日志输出目录

排查优先级：

1. 看 `temu-reports/codex.audit.log` 判断 Codex wrapper 是否启动、重试、成功。
2. 看 `temu-reports/codex.err.log` 和 `temu-reports/codex.out.log` 找命令级错误。
3. 看最新 `temu-all-accounts-*.json`，确认 `productSource`、每店 `source`、`failures`、`apiComparison`。
4. 看最新 `temu-abnormal-orders-*.json`，确认异常巡店是否全店成功。
5. 看最新 `temu-price-adjust-reject-*.json`，确认调价待办是否只执行了拒绝且剩余为 0。
6. 看最新 `temu-operation-status-*.json`，确认每店 `regionCounts`、`inSaleSpuCount` 和 `missingInSaleProducts`。
7. 必要时用 `npm run temu:report:api:capture` 或 `npm run temu:report:capture` 生成脱敏 Network 捕获文件。

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

Codex 入口会加载 `.env.local`、重置两个 CDP 端口、唤醒桌面、用 `caffeinate` 包住采集和发送流程，并把审计日志写入 `temu-reports/codex.audit.log`。产品广告报表默认使用接口切店和接口采集；出库单异常默认通过 agentseller API 用 `mallid` 分店拉取数量和明细。需要临时回退页面采集时，可分别设置 `TEMU_PRODUCT_SOURCE=dom` 或 `TEMU_ABNORMAL_SOURCE=dom`。命令失败时默认会重试一次；如果重试后仍失败，命令会保留非零退出码，让 Codex 自动化继续排查日志、修复脚本并重跑到完成。

汇总图片标题使用 `欧区销量汇总 YYYY-MM-DD HH:mm:ss`，时间取多账号脚本启动时间；副标题显示 `对比日期：上一日 HH:mm:ss`。图片顶部用两张加粗卡片展示总件数和总销售额，并在数值同一行显示相对上一日的红绿箭头百分比变化；下方按店铺分组列出商品图、总花费、净件数、净销售额、曝光量、点击率和转化率。店铺名只显示在小计行，小计行只展示该店铺件数和销售额，并分别在数值下方显示相对上一日的红绿箭头百分比变化，百分比不带矩形底色。图片中的商品明细每个店铺只展示净销售额前 5 且净销售额大于 0 的商品，完整商品明细仍保留在 JSON 中。夜间任务点击 `昨日` 并统计昨日数据，企业微信 markdown 文字口径仍使用昨日汇总。企业微信通过 `WECOM_WEBHOOK_URL` 群机器人 webhook 先发送 markdown 标题，再发送图片。

### 汇总图片和企业微信推送规则

`npm run temu:report:all:image` 是定时任务使用的正式发送入口：

- 先生成所有账号合并 JSON，再用 `scripts/temu-summary-image.mjs` 生成 `780px` 宽的紧凑图片表格
- 图片标题格式为 `欧区销量汇总 YYYY-MM-DD HH:mm:ss`；时间优先取 `temu-all-accounts-*.json` 文件名里的多账号脚本启动时间；`TEMU_REPORT_DATE=yesterday` 时日期会按该启动时间的上海日期减一天
- 图片副标题格式为 `对比日期：上一日 HH:mm:ss`
- 图片顶部用两张加粗卡片显示总件数、总销售额；两个数值同一行显示相对上一日的红绿箭头百分比变化
- 商品表按店铺分组；小计行背景加深，只显示店铺名、净件数和净销售额，不显示“小计”字样；小计行的净件数和净销售额下方显示相对上一日的红绿箭头百分比变化，百分比不带矩形底色；商品行列固定为 `商品图`、`总花费`、`净件数`、`净销售额`、`曝光量`、`点击率`、`转化率`，列宽平均分配
- 商品按店铺内净销售额从大到小排序，图片中每个店铺只展示净销售额前 5 且净销售额大于 0 的商品；完整商品明细仍保留在 JSON 中，不因图片截断而裁剪
- 商品图片会下载缓存到 `temu-reports/product-images`
- 对比基准自动选择“上一日、报告更新时间最接近当前报告时间”的 `temu-all-accounts-*.json`
- 对比基准会优先选择相同 `TEMU_REPORT_DATE` 口径的历史报告，避免 `昨日` 报告误用 `今日` 报告做环比
- 正增长使用绿色上三角，负增长使用红色下三角，无变化或缺少基准使用灰色提示
- 企业微信只通过 `WECOM_WEBHOOK_URL` 群机器人 webhook 发送，不使用 `wecom-cli`；发送顺序为销售汇总 markdown 标题、销售汇总图片、店铺运营状态 `markdown_v2` 表格
- `npm run temu:report:all:image` 由 `scripts/temu-report-all-image-flow.mjs` 顺序编排；任何子脚本失败都会让总流程失败，后续步骤使用本轮刚生成的 JSON 路径，避免误读旧的最新文件
- `TEMU_REPORT_DATE=yesterday` 时，广告数据完成后会执行店铺运营状态巡店，并单独发送企业微信 `markdown_v2` 运营状态表格
- `TEMU_REPORT_DATE=today` 时，广告数据完成后会通过 `scripts/temu-run-agentseller-checks.mjs` 按顺序执行出库单异常巡店、调价待办批量拒绝和店铺运营状态巡店；出库单异常全部为 0 时显示 `今日出库单异常0条。`，否则逐店显示异常条数
- agentseller runner 只做顺序调度，不并发、不共享同一个标签页；两个子脚本仍使用同一个账号 Chrome profile，因此登录态一致，但各自按原有逻辑完整打开和关闭 CDP Chrome
- 运营状态表格使用企业微信 webhook `markdown_v2` 类型，因为普通 `markdown` 不支持表格；`markdown_v2` 支持表格但不支持字体颜色
- 运营状态主表表头固定为 `店铺`、`在售SPU数`
- 新增异常 SPU 指上一份快照中在售、当前快照中不在售或缺失的 SPU ID；如果存在异常，表格下方追加二级标题 `今日新增异常SPU` 和 `店铺`、`SPU ID` 表格；上一份在售 SPU 列表为空时自然不报异常，也不会追加该段
- 为避免企业微信手机端表格换行，运营状态表格只在展示层使用短店名；例如 `Whitine Products Global` 显示为 `Whitine Global`，`LEEEV Global Outlet` 显示为 `LEEEV Outlet`，JSON 里的真实店铺名不变

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

调价待办 dry-run，只读取待卖家确认列表，不提交：

```bash
npm run temu:price-adjust-reject:dry
```

调价待办批量拒绝，拒绝原因固定为 `0`：

```bash
npm run temu:price-adjust-reject
```

按顺序执行出库单异常巡店、调价待办批量拒绝和店铺运营状态巡店，只生成 JSON，不发送企业微信：

```bash
npm run temu:agentseller-checks
```

店铺运营状态巡店，只生成 JSON，不发送企业微信：

```bash
npm run temu:operation-status
```

从最新店铺运营状态 JSON 发送或预览企业微信 `markdown_v2` 表格：

```bash
npm run temu:operation-status:markdown
```

从最新店铺运营状态 JSON 生成备用图片表格，不发送企业微信：

```bash
npm run temu:operation-status:image
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

异常巡店会直接从 `https://agentseller.temu.com/lgst/auth-warehouse/abnormal-order` 启动，被重定向时再处理登录/授权；默认 API 模式下，每个配置店铺会按精确店名匹配 `userInfo.mallList` 里的唯一 `mallId`，再带 `mallid` 请求异常数量和异常明细，省掉页面切店。异常数量会和明细接口 `totalCount` 互相校验。若店铺无权限访问该异常页，JSON 会记录为无权限而不是误报 0 条；若触发短信或验证码，需要在对应 CDP Chrome profile 中完成验证后重跑。

巡检会自动：

- 打开 Temu 广告后台
- 登录态失效时点击右上角登录，选择非当地卖家，并优先使用 Chrome 保存密码自动登录
- 登录后先确认当前店铺名；产品报表走接口或页面切店，异常巡店默认走 agentseller API 的 `mallid` 分店请求
- 切换到欧区
- 进入数据报表
- 打开商品数据报表
- 按 `TEMU_REPORT_DATE` 强制点击 `今日` 或 `昨日`，并验证对应筛选处于选中状态
- 按净申报价销售额（全店）降序排序；若店铺没有净销售额列，则回退到申报价销售额（全店）
- 验证排序表头的下三角为蓝色，同时验证表格数据为从高到低
- `npm run temu:report:all` 只生成所有账号的合并 JSON
- `npm run temu:report:all:image` 生成紧凑汇总图片，并通过企业微信群机器人 webhook 发送销售汇总 markdown 标题、图片和店铺运营状态表格

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
- `TEMU_ABNORMAL_SOURCE=api|dom`: 出库单异常采集来源，默认 `api`；设置为 `dom` 时回退旧页面切店和页面读取
- `TEMU_ABNORMAL_API_DOM_FALLBACK=0`: `TEMU_ABNORMAL_SOURCE=api` 时关闭 DOM 兜底，接口失败会直接报错
- `TEMU_ABNORMAL_API_PAGE_SIZE`: 出库单异常 API 明细每页条数，默认 `10`，与页面请求保持一致
- `TEMU_OPERATION_SHOPS`: 覆盖店铺运营状态巡检店铺列表，默认使用账号配置里的 `shops`
- `TEMU_OPERATION_PAGE_SIZE`: 店铺运营状态 `pageQuery` 每页条数，默认 `100`
- `TEMU_OPERATION_ACCOUNT_RETRY_ATTEMPTS`: 店铺运营状态单账号失败重试次数，默认 `2`
- `TEMU_OPERATION_COMPARE=0`: 关闭店铺运营状态和上一份快照的下架异常比对
- `TEMU_OPERATION_COMPARE_INPUT`: 指定店铺运营状态对比基准 JSON
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

Codex 自动化会调用 `npm run temu:report:codex:yesterday` 和 `npm run temu:report:codex:today`。入口 `/Users/vure/ReportDalily/scripts/run-codex-temu-report.sh` 会先用 `caffeinate -u` 声明用户活跃并等待桌面恢复，再用 `caffeinate -d -i -m` 包住整次采集。产品广告数据默认走 `TEMU_PRODUCT_SOURCE=api`，从页面登录态调用 Temu 接口切店和拉取报表；出库单异常默认走 `TEMU_ABNORMAL_SOURCE=api`，从 agentseller 登录态按 `mallid` 拉取异常数量和明细；店铺运营状态默认走 agentseller `product/skc/pageQuery`。需要调试旧路径时，可临时设置 `TEMU_PRODUCT_SOURCE=dom` 或 `TEMU_ABNORMAL_SOURCE=dom`。

`09:00` 的 `today` 流程中，广告数据跑完后会用 `npm run temu:agentseller-checks` 按顺序跑出库单异常、调价待办批量拒绝和店铺运营状态；三个检查完成后再发送销售汇总图片和店铺运营状态 `markdown_v2` 表格。

历史 launchd 入口 `/Users/vure/ReportDalily/scripts/run-temu-report-all.sh` 保留为手动备用，不再作为当前定时源，避免和 Codex 自动化重复发送。

日报、异常巡店和 CDP 登录脚本结束时会默认关闭对应 CDP 专用 profile 下的 Chrome 标签页，避免残留页面影响后续自动化任务。需要调试保留页面时，可临时加 `TEMU_CLOSE_CHROME_PAGES=0`。

企业微信webhook开发文档: https://developer.work.weixin.qq.com/document/path/99110
