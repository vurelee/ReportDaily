# Temu Agentseller 页面内 API 获取和调用手册

本文档记录 `/Users/vure/ReportDalily` 当前验证过的 `agentseller.temu.com` 页面内 API 获取、复现和自动化调用方式，用于后续扩展其它 Temu 商家中心页面 API。

## 核心原则

1. 通过本机 Chrome CDP profile 复用登录态，不在 Node.js 里直接裸请求 Temu 接口。
2. 先打开 `agentseller.temu.com` 同域页面，完成登录、授权和前端初始化，再在页面上下文里调用 API。
3. API 请求使用 `page.evaluate(() => fetch(...))` 在浏览器页面内执行，这样会自动携带同域 cookie、浏览器会话和部分前端运行环境。
4. 店铺维度接口不要靠页面切店识别，优先从 `/api/seller/auth/userInfo` 取得 `mallList`，按精确店名匹配 `mallId`，再在请求头带 `mallid`。
5. 任何店铺名必须精确匹配。`Whitine Products` 和 `Whitine Products Global` 是不同店铺。
6. 已确认的接口可以 API 优先；DOM 读取只作为调试或临时回退。

## 是否必须打开目标页面

抓新接口时需要打开目标功能页，因为要观察 Network 请求、确认 endpoint、请求体、请求头、响应结构和页面行为。

正式自动化调用时，不一定要打开到“目标页面并读取 DOM”，但建议至少打开同域的目标功能页或相近页面，例如：

- 商品列表：`https://agentseller.temu.com/goods/list`
- 出库单异常：`https://agentseller.temu.com/lgst/auth-warehouse/abnormal-order`

原因：

- 目标页能触发 agentseller 登录和授权流程。
- 页面前端 bundle 会初始化部分风险校验逻辑，例如当前脚本使用的 `Anti-Content` 生成逻辑。
- 页面内 `fetch` 可以天然携带 cookie，比 Node.js `fetch` 更稳。

如果只是按顺序执行多个 agentseller API 任务，可以使用同一个账号 Chrome profile 登录态依次执行。当前正式入口是 `npm run temu:agentseller-checks`：先跑出库单异常，再跑店铺运营状态。它不并发、不共享同一个标签页，避免互相导航或关闭页面。

## CDP 登录态和账号配置

账号、Chrome profile 和端口来自 `temu-accounts.json`：

```json
{
  "id": "setonr",
  "label": "SETONR",
  "cdpProfileDir": "/Users/vure/ReportDalily/temu-chrome-cdp-profile",
  "cdpPort": 9222,
  "shops": ["SETONR Products", "SETONR Origin"]
}
```

脚本启动逻辑：

1. 检查 `http://127.0.0.1:<cdpPort>/json/version`，确认 CDP 是否可连接。
2. 如果端口未就绪，用对应 `cdpProfileDir` 启动 Google Chrome：

```bash
open -na "Google Chrome" --args \
  --remote-debugging-port=9222 \
  --user-data-dir=/Users/vure/ReportDalily/temu-chrome-cdp-profile \
  --no-first-run \
  --no-default-browser-check \
  --window-size=1440,1000 \
  https://agentseller.temu.com/goods/list
```

3. Playwright 用 `chromium.connectOverCDP()` 连接该 Chrome。
4. 优先复用已打开的 `https://agentseller.temu.com/` 标签页，没有则新建。

关键点：登录态保存在 Chrome profile 中，不保存在脚本内。不要打印或复制 cookie、token、`.env.local`、webhook 等敏感信息。

## 页面内 API 请求模板

agentseller API 当前采用 `page.evaluate` 包一层浏览器内 `fetch`：

```js
async function agentSellerApiPost(page, endpoint, body = undefined, { mallId } = {}) {
  const url = endpoint.startsWith("http")
    ? endpoint
    : `https://agentseller.temu.com${endpoint}`;

  return await page.evaluate(
    async ({ url, body, hasBody, mallId }) => {
      const headers = {
        accept: "application/json, text/plain, */*",
        "content-type": "application/json",
      };

      const antiContent = await antiContentValue();
      if (antiContent) headers["Anti-Content"] = antiContent;
      if (mallId) headers.mallid = String(mallId);

      const response = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers,
        ...(hasBody ? { body: JSON.stringify(body || {}) } : {}),
      });

      const text = await response.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }

      return {
        ok: response.ok,
        status: response.status,
        url: response.url,
        body: parsed,
        text: parsed ? "" : text.slice(0, 1000),
      };
    },
    { url, body, hasBody: body !== undefined, mallId },
  );
}
```

注意点：

- `credentials: "include"` 必须保留。
- `content-type` 通常用 `application/json`。
- 店铺维度 API 要带请求头 `mallid`，值来自 `/api/seller/auth/userInfo`。
- 不要在 Node.js 进程里直接 `fetch("https://agentseller.temu.com/...")`，那样没有页面 cookie 和前端风险参数，容易 401、403 或业务失败。

## Anti-Content 处理

当前 agentseller 页面 API 需要尽量带 `Anti-Content` 请求头。脚本从页面 webpack chunk 里调用风险工具模块生成：

```js
async function antiContentValue() {
  try {
    if (!window.__codexTemuChunkRequire) {
      const factories = {};
      for (const chunk of self["webpackJsonp_bg-agent-seller-lgst"] || []) {
        const modules = chunk?.[1];
        if (!modules || typeof modules !== "object") continue;
        Object.assign(factories, modules);
      }

      const cache = {};
      const chunkRequire = (id) => {
        const key = String(id);
        if (cache[key]) return cache[key].exports;
        const factory = factories[key];
        if (!factory) throw new Error(`module ${key} not found`);
        const module = { exports: {} };
        cache[key] = module;
        factory.call(module.exports, module, module.exports, chunkRequire);
        return module.exports;
      };

      chunkRequire.d = (exports, definition) => {
        for (const key of Object.keys(definition)) {
          if (!Object.prototype.hasOwnProperty.call(exports, key)) {
            Object.defineProperty(exports, key, { enumerable: true, get: definition[key] });
          }
        }
      };
      chunkRequire.o = (object, property) => Object.prototype.hasOwnProperty.call(object, property);
      chunkRequire.r = (exports) => {
        if (typeof Symbol !== "undefined" && Symbol.toStringTag) {
          Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
        }
        Object.defineProperty(exports, "__esModule", { value: true });
      };
      chunkRequire.n = (module) => {
        const getter = module && module.__esModule ? () => module.default : () => module;
        chunkRequire.d(getter, { a: getter });
        return getter;
      };

      window.__codexTemuChunkRequire = chunkRequire;
    }

    const riskUtil = window.__codexTemuChunkRequire?.(65531);
    if (typeof riskUtil?.cN === "function") return await riskUtil.cN();
    if (typeof riskUtil?.xy === "function") return riskUtil.xy();
  } catch {
    return "";
  }
  return "";
}
```

这个模块 ID 和全局 chunk 名来自当前页面实现：

- chunk 全局名：`webpackJsonp_bg-agent-seller-lgst`
- 风险模块：`65531`
- 可用方法：优先 `cN()`，其次 `xy()`

后续页面如果 API 请求失败，优先检查：

- 目标页是否已加载对应 webpack chunk。
- `self["webpackJsonp_bg-agent-seller-lgst"]` 是否存在。
- 模块 `65531` 是否仍然存在。
- Network 里实际请求是否带了新的风险头或其它必需头。

## 店铺 mallId 获取

所有店铺维度 API 先调用：

```http
POST https://agentseller.temu.com/api/seller/auth/userInfo
```

请求体：

```json
{}
```

从响应的 `result.mallList` 里按店名精确匹配：

```js
function mallInfoForShop(malls, shopName) {
  const matches = (malls || []).filter((mall) => cleanText(mall.mallName) === shopName);
  if (matches.length !== 1) {
    throw new Error(`店铺列表接口中找不到唯一精确店名：${shopName}；匹配数=${matches.length}`);
  }

  const mall = matches[0];
  const mallId = String(mall.mallId || "");
  if (!mallId) throw new Error(`${shopName} 缺少 mallId`);

  return {
    mallId,
    mallName: cleanText(mall.mallName),
    managedType: mall.managedType ?? null,
    mallMode: mall.mallMode ?? null,
    uniqueId: mall.uniqueId || "",
  };
}
```

后续请求通过请求头传店铺：

```js
headers.mallid = String(mallId);
```

## 响应校验规则

统一校验 HTTP 和业务状态：

```js
function assertAgentSellerApiResponse(response, label) {
  if (!response?.ok) {
    throw new Error(`${label} HTTP ${response?.status || "unknown"}: ${response?.text || ""}`);
  }

  const body = response.body;
  if (!body || typeof body !== "object") {
    throw new Error(`${label} 返回非 JSON: ${response.text || ""}`);
  }

  const errorCode = body.errorCode ?? body.error_code;
  if (body.success === false || (errorCode !== undefined && Number(errorCode) !== 1000000)) {
    const msg = body.errorMsg || body.error_msg || body.message || "unknown";
    throw new Error(`${label} 返回失败: code=${errorCode ?? "unknown"} msg=${msg}`);
  }

  return body;
}
```

通常业务数据在 `body.result` 下。不同接口字段不一致，必须以 Network 捕获或实际响应为准。

## 当前已验证接口

### 店铺列表

```http
POST https://agentseller.temu.com/api/seller/auth/userInfo
```

用途：

- 取得当前账号可访问店铺。
- 精确匹配 `mallName`。
- 拿到 `mallId`，供后续请求头 `mallid` 使用。

### 商品列表 / 店铺运营状态

```http
POST https://agentseller.temu.com/visage-agent-seller/product/skc/pageQuery
```

请求头：

```text
mallid: <mallId>
Anti-Content: <页面内生成>
```

请求体：

```json
{
  "page": 1,
  "pageSize": 100
}
```

分页：

1. 先请求第 1 页。
2. 读取 `result.total`。
3. `Math.ceil(total / pageSize)` 计算总页数。
4. 按页继续请求，合并 `result.pageItems`。

当前口径：

- SPU ID：`productId`
- SKC ID：`productSkcId`
- 在售：`skcSiteStatus=1` 且 `removeStatus=0`
- 经营站点：`productSemiManaged.bindSites[].siteName`
- 德国站计欧区，英国站计英区，美国站计美区。

### 出库单异常数量

```http
POST https://agentseller.temu.com/api/bg/cw/order/queryAbnormalOrderSum
```

请求头：

```text
mallid: <mallId>
Anti-Content: <页面内生成>
```

请求体：

```json
{}
```

响应字段：

- `result.abnormalOrderSum`

### 出库单异常明细

```http
POST https://agentseller.temu.com/api/bg/cw/order/pageCwNormalOrderShippingInfo
```

请求头：

```text
mallid: <mallId>
Anti-Content: <页面内生成>
```

请求体：

```json
{
  "pageNo": 1,
  "pageSize": 10,
  "queryTabValue": 6,
  "displayOrderStatusList": [99]
}
```

当前校验：

- 数量接口 `abnormalOrderSum` 必须和明细接口 `totalCount` 一致。
- 明细按 `totalCount / pageSize` 分页拉全。
- 无权限访问时记录 `NO_PERMISSION`，不能误报为 0。

## 获取其它页面 API 的推荐流程

### 1. 打开目标页并确认登录态

用对应账号 CDP profile 打开目标页。例如：

```bash
TEMU_ACCOUNT_ID=setonr npm run temu:operation-status
```

如果是新页面，可以临时在脚本里把目标 URL 改为目标页，或者新建探针脚本。不要用 `ads.temu.com` 处理 agentseller 任务。

### 2. 开启 Network capture

通用捕获开关：

```bash
TEMU_CAPTURE_NETWORK=1 TEMU_ACCOUNT_ID=setonr npm run temu:abnormal
```

常用环境变量：

```bash
TEMU_CAPTURE_NETWORK=1
TEMU_CAPTURE_NETWORK_ALL=1
TEMU_CAPTURE_NETWORK_MAX_EVENTS=1200
TEMU_CAPTURE_NETWORK_MAX_BODY_CHARS=200000
TEMU_CAPTURE_NETWORK_FLUSH_TIMEOUT_MS=7000
```

输出文件：

```text
temu-reports/temu-network-capture-<kind>-<label>-<timestamp>.json
```

捕获内容会脱敏请求头、URL 参数、请求体和响应体中的敏感字段。仍然不要把完整捕获文件发到外部。

### 3. 在页面上操作一次目标功能

例如：

- 切换筛选条件。
- 点击查询。
- 翻页。
- 打开某个弹窗。
- 导出或查看明细。

目标是让页面发出真实 API 请求。

### 4. 从捕获结果里筛选业务接口

优先看：

- `method` 是否为 `POST`。
- URL 是否包含 `/api/`、`/bg/`、`query`、`list`、`page`、`search`。
- 请求体是否包含页面筛选条件。
- 响应体是否包含页面展示的数据。
- 是否需要 `mallid` 请求头。
- 是否需要分页字段，例如 `page`、`pageNo`、`pageSize`。

不要优先追踪日志、埋点、风控、性能监控接口。

### 5. 抽取最小请求

记录以下信息：

```text
页面 URL:
接口 URL:
方法:
请求头:
请求体:
响应成功标志:
业务数据路径:
分页字段:
店铺字段:
异常/无权限响应:
```

然后用 `agentSellerApiPost` 复现，先单店、单页测试。

### 6. 加入脚本并保留 DOM 回退口

新增 API 功能时建议：

- 默认 API 优先。
- 保留 `*_SOURCE=dom|api` 或 `*_API_DOM_FALLBACK=0` 这类开关。
- 严格验证时设置 fallback 为 0，让 API 错误直接暴露。
- 每个接口记录 `endpoints`、`request`、`source` 到输出 JSON，方便后续审计。

## 新 API 脚本骨架

```js
const AGENT_SELLER_ORIGIN = "https://agentseller.temu.com";
const targetUrl = "https://agentseller.temu.com/<target-page>";

async function collectNewFeatureByApi(page, shopName, apiMalls) {
  const mall = mallInfoForShop(apiMalls, shopName);

  const result = await agentSellerApiResult(
    page,
    "/api/path/to/newEndpoint",
    {
      page: 1,
      pageSize: 100,
    },
    { mallId: mall.mallId },
    `${shopName} 新接口`,
  );

  return {
    shopName,
    source: "direct-api",
    apiSwitch: mall,
    rawCount: Array.isArray(result.pageItems) ? result.pageItems.length : 0,
    apiReport: {
      endpoints: {
        mallList: `${AGENT_SELLER_ORIGIN}/api/seller/auth/userInfo`,
        target: `${AGENT_SELLER_ORIGIN}/api/path/to/newEndpoint`,
      },
      request: {
        mallId: mall.mallId,
        pageSize: 100,
      },
    },
  };
}
```

调用顺序：

```js
const { browser, context, page } = await connectCdpChrome(account, targetUrl);
try {
  const activePage = await ensureTargetPage(context, page);
  const apiMalls = await operationApiMallList(activePage);

  for (const shopName of shops) {
    const report = await collectNewFeatureByApi(activePage, shopName, apiMalls);
    reports.push(report);
  }
} finally {
  await closeCdpPages(context);
  await browser.close().catch(() => {});
  await closeCdpChromeProcess(account.cdpPort);
}
```

## 常见问题排查

### HTTP 401 / 403

可能原因：

- Chrome profile 登录态失效。
- 没有打开 agentseller 同域页面。
- 页面授权未完成。
- 请求不是在页面内 `fetch` 执行。
- 缺少 `Anti-Content` 或新的风险请求头。

处理：

1. 手动打开对应 CDP Chrome profile。
2. 完成登录、授权、短信或验证码。
3. 重新跑单账号脚本。
4. 开启 `TEMU_CAPTURE_NETWORK=1` 对比页面真实请求。

### 店铺列表为空

可能原因：

- 当前账号没有 agentseller 权限。
- 仍在登录页或授权页。
- 请求域不对。
- userInfo 接口返回结构变化。

处理：

- 确认页面 URL 是 `https://agentseller.temu.com/...`。
- 查看 `/api/seller/auth/userInfo` 实际响应。
- 确认 `result.mallList` 路径是否变化。

### 找不到目标店铺

可能原因：

- 店铺名配置不精确。
- 当前账号没有该店铺权限。
- `mallName` 字段变化。

处理：

- 打印脱敏后的 `mallList.map(mall => mall.mallName)`。
- 修改 `temu-accounts.json`，不要做模糊匹配。

### 返回成功但数据和页面不同

可能原因：

- 请求体缺少筛选条件。
- 页面还有隐藏默认参数。
- `mallid` 不对。
- 分页未拉全。
- 页面显示的是聚合数据，接口返回的是 SKC/SKU/SPU 维度。

处理：

- 用 Network capture 对比页面真实请求体。
- 确认所有筛选条件和分页字段。
- 记录接口维度，不要把 SKC 数误当 SPU 数。

### 页面或浏览器被关闭

可能原因：

- 两个脚本并发操作同一个 CDP profile。
- 一个脚本关闭了另一个脚本正在用的页面。
- 调试时残留 Chrome 进程状态异常。

处理：

- agentseller 检查按顺序执行。
- 必要时先关闭对应 CDP 端口后重跑。
- 调试保留页面时再设置 `TEMU_CLOSE_CHROME_PAGES=0`。

## 验证命令

只跑出库单异常：

```bash
TEMU_ACCOUNT_ID=setonr npm run temu:abnormal
```

只跑店铺运营状态：

```bash
TEMU_ACCOUNT_ID=setonr npm run temu:operation-status
```

按顺序跑两个 agentseller 检查：

```bash
TEMU_ACCOUNT_ID=setonr npm run temu:agentseller-checks
```

开启接口捕获：

```bash
TEMU_CAPTURE_NETWORK=1 TEMU_ACCOUNT_ID=setonr npm run temu:abnormal
```

严格验证 API，不允许 DOM 兜底：

```bash
TEMU_ABNORMAL_API_DOM_FALLBACK=0 TEMU_ACCOUNT_ID=setonr npm run temu:abnormal
```

## 新接口接入检查清单


- [ ] 目标页 URL 已确认，且属于 `agentseller.temu.com`。
- [ ] Network capture 已拿到真实请求和响应。
- [ ] endpoint、请求体、分页、筛选条件已记录。
- [ ] 是否需要 `mallid` 已确认。
- [ ] `/api/seller/auth/userInfo` 可拿到目标店铺 `mallId`。
- [ ] 请求在 `page.evaluate` 内执行，带 `credentials: "include"`。
- [ ] `Anti-Content` 已尝试生成并带入。
- [ ] 成功、失败、无权限响应都已处理。
- [ ] 输出 JSON 记录 `source`、`endpoints`、`request` 和关键计数。
- [ ] 单账号验证通过后，再接入多账号和定时流程。
