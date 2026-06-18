# Temu AgentSeller 页面内 API 获取指南

## 目标

# 本文档记录 `/Users/vure/ReportDalily` 当前调用 `agentseller.temu.com` 页面内 API 的技术细节，供后续扩展其它 AgentSeller 页面接口时复用。

当前实现不是 DOM 表格采集，也不是纯 Node HTTP 请求；它是 **browser-authenticated API-first**：

1. 复用本机 Chrome CDP profile 里的 Temu 登录态。
2. 打开或复用 `agentseller.temu.com` 页面，完成必要的登录和授权。
3. 在页面上下文里执行 `fetch`，让请求自动带上当前页面 cookie、授权态和同源环境。
4. 从页面 webpack runtime 里生成 `Anti-Content`，再调用接口。
5. 数据按 API 响应解析，不通过页面跳转、切店、读 DOM 表格获取。

关键代码位置：

- `scripts/temu-abnormal-orders.mjs`
- `scripts/temu-operation-status.mjs`
- `scripts/temu-network-capture.mjs`

## 为什么仍然需要页面上下文

AgentSeller API 目前依赖浏览器登录态和页面运行时能力：

- Cookie 和授权态来自 Chrome profile。
- 请求使用 `credentials: "include"`，由浏览器自动携带当前登录 cookie。
- 风控头 `Anti-Content` 来自页面 JS bundle 内的 runtime 方法。
- 有些页面首次访问会触发 `agentseller.temu.com/auth/authentication` 或 `seller.kuajingmaihuo.com/settle/seller-login` 授权流程。

因此脚本会打开页面来建立可用 API 上下文，但正式数据读取仍走 API。后续扩展其它页面时，原则是：页面只用于登录、授权、加载对应 bundle 和提供 API 调用上下文；数据不要从 DOM 读。

## 基础调用模型

当前两个 agentseller 脚本都使用同一类封装：

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

要点：

- `endpoint` 可以传相对路径，也可以传完整 URL。
- 请求方法当前统一使用 `POST`。
- 请求体用 JSON。
- `credentials: "include"` 必须保留。
- 店铺级接口通过 header `mallid` 指定店铺，不需要页面切店。
- 响应先读文本，再尝试 JSON parse，便于记录非 JSON 错误。

## Anti-Content 生成

`Anti-Content` 是 AgentSeller 接口常见的风控头。当前做法是在页面内重建 webpack require，然后调用页面 bundle 中的风险工具模块：

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
            Object.defineProperty(exports, key, {
              enumerable: true,
              get: definition[key],
            });
          }
        }
      };
      chunkRequire.o = (object, property) =>
        Object.prototype.hasOwnProperty.call(object, property);
      chunkRequire.r = (exports) => {
        if (typeof Symbol !== "undefined" && Symbol.toStringTag) {
          Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
        }
        Object.defineProperty(exports, "__esModule", { value: true });
      };
      chunkRequire.n = (module) => {
        const getter = module && module.__esModule
          ? () => module.default
          : () => module;
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

注意事项：

- 当前 chunk 名是 `webpackJsonp_bg-agent-seller-lgst`。
- 当前风险模块 id 是 `65531`。
- 优先调用异步方法 `cN()`，没有时回退 `xy()`。
- 如果打开的页面没有加载对应 chunk，可能拿不到模块；扩展新页面时，应先打开该功能页面所在路由，让页面 bundle 加载完成。
- 不要把 `Anti-Content` 当作固定值保存；每次请求前在页面内重新生成更稳。

## 响应校验

当前封装认为以下情况失败：

- HTTP 非 2xx。
- 响应不是 JSON。
- `success === false`。
- 存在 `errorCode` 或 `error_code` 且不是 `1000000`。

通用校验逻辑：

```js
function assertAgentSellerApiResponse(response, label) {
  if (!response?.ok) {
    throw new Error(`${label} HTTP ${response?.status || "unknown"}`);
  }

  const body = response.body;
  if (!body || typeof body !== "object") {
    throw new Error(`${label} returned non-JSON`);
  }

  const errorCode = body.errorCode ?? body.error_code;
  if (body.success === false || (errorCode !== undefined && Number(errorCode) !== 1000000)) {
    const message = body.errorMsg || body.error_msg || body.message || "unknown";
    throw new Error(`${label} failed: code=${errorCode ?? "unknown"} msg=${message}`);
  }

  return body;
}
```

业务数据通常在 `body.result` 下：

```js
async function agentSellerApiResult(page, endpoint, body = undefined, options = {}, label = "Agent Seller API") {
  const response = await agentSellerApiPost(page, endpoint, body, options);
  return assertAgentSellerApiResponse(response, label).result || {};
}
```

## 店铺 mallId 获取

后续所有按店铺分隔的接口，优先通过 `userInfo` 获取 `mallId`：

```http
POST https://agentseller.temu.com/api/seller/auth/userInfo
```

请求体：

```json
{}
```

响应里的关键字段：

```json
{
  "result": {
    "mallList": [
      {
        "mallId": "...",
        "mallName": "SETONR Products",
        "managedType": 0,
        "mallMode": 0,
        "uniqueId": "..."
      }
    ]
  }
}
```

匹配规则：

- 必须按 `mallName` 精确匹配。
- 不要模糊匹配，`Whitine Products` 和 `Whitine Products Global` 是不同店铺。
- 如果匹配数不是 1，直接失败，不要自动猜。
- 请求后续店铺接口时，把 `mallId` 放在 header `mallid` 中。

示例：

```js
const malls = result.mallList || [];
const matches = malls.filter((mall) => cleanText(mall.mallName) === shopName);
if (matches.length !== 1) throw new Error(`mallName not unique: ${shopName}`);

const mallId = String(matches[0].mallId || "");
```

## 已验证接口

### 店铺列表

用途：获取当前账号可见店铺和每个店铺的 `mallId`。

```http
POST /api/seller/auth/userInfo
```

请求体：

```json
{}
```

不需要 `mallid` header。

### 出库单异常数量

用途：获取某店铺异常出库单总数。

```http
POST /api/bg/cw/order/queryAbnormalOrderSum
```

请求体：

```json
{}
```

需要 header：

```text
mallid: <mallId>
```

关键响应字段：

```json
{
  "result": {
    "abnormalOrderSum": 0
  }
}
```

### 出库单异常明细

用途：分页获取异常出库单明细。

```http
POST /api/bg/cw/order/pageCwNormalOrderShippingInfo
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

需要 header：

```text
mallid: <mallId>
```

关键响应字段：

```json
{
  "result": {
    "totalCount": 0,
    "resultList": []
  }
}
```

当前脚本会校验：

- `queryAbnormalOrderSum.result.abnormalOrderSum`
- `pageCwNormalOrderShippingInfo.result.totalCount`

两者必须一致，否则认为接口口径不一致。

### 商品运营状态

用途：获取商品 SKC 列表，并整理 SPU 在售状态、站点和下架异常。

```http
POST /visage-agent-seller/product/skc/pageQuery
```

请求体：

```json
{
  "page": 1,
  "pageSize": 100
}
```

需要 header：

```text
mallid: <mallId>
```

关键响应字段：

```json
{
  "result": {
    "total": 153,
    "pageItems": []
  }
}
```

当前脚本分页规则：

- 第 1 页读取 `result.total`。
- 总页数为 `ceil(total / pageSize)`。
- 从第 2 页继续拉到最后。
- 如果某页 `pageItems` 为空，提前停止。
- 用 `productSkcId` 去重 SKC。

当前在售规则：

- `skcSiteStatus === 1`
- `removeStatus === 0`

站点来源：

- `productSemiManaged.bindSites[].siteName`

区域映射：

- 包含 `德国站` 或 `德国`：欧区。
- 包含 `英国站` 或 `英国`：英区。
- 包含 `美国站` 或 `美国`：美区。

## Seller Center 资金中心页面 API

资金中心不在 `agentseller.temu.com`，页面是：

```text
https://seller.kuajingmaihuo.com/labor/account
```

当前已验证的可提现金额来源是 Seller Center 页面内 API。页面负责复用 Chrome 登录态和当前店铺 session，数据读取走接口，不从 DOM 表格采集。

### Seller Center 店铺列表

用途：获取当前账号可见店铺、精确店名和 `mallId`。

```http
POST /bg/quiet/api/mms/userInfo
```

请求体：

```json
{}
```

关键响应字段：

```json
{
  "result": {
    "companyList": [
      {
        "malInfoList": [
          {
            "mallId": 634418216263713,
            "mallName": "SETONR Products",
            "mallMode": 1,
            "isSemiManagedMall": true
          }
        ]
      }
    ]
  }
}
```

匹配规则继续使用精确 `mallName`，不要模糊匹配。

### 当前店铺实体校验

用途：确认页面当前 session 对应的店铺，避免切店后拿错余额。

```http
POST /api/merchant/payment/account/mall/entity/query
```

请求体：

```json
{}
```

关键响应字段：

```json
{
  "result": {
    "mallId": 634418216263713,
    "entityId": 634418214714893,
    "mallStatus": 1
  }
}
```

当前脚本会校验这里的 `mallId` 等于目标店铺的 `mallId`。

### 可提现金额

用途：获取资金中心页面里的可提现金额。当前口径不是只取页面 `可用余额(CNY)`，而是：

```text
可提现金额 = 可用余额 + 发起申请 + 银行处理中
```

其中 `可用余额` 来自页面标签 `可用余额(CNY)`。

```http
POST /api/merchant/payment/account/amount/info
```

请求体：

```json
{}
```

关键响应字段：

```json
{
  "result": {
    "currency": "CNY",
    "availableBalance": "3966.94",
    "availableBalanceFormat": {
      "value": 396694,
      "symbol": "¥",
      "currencyCode": "CNY",
      "digitalText": "3,966.94"
    }
  }
}
```

提现记录表格接口：

```http
POST /api/merchant/payment/account/withdraw/cash/record
```

请求体：

```json
{
  "page": 1,
  "pageSize": 100
}
```

关键响应字段：

```json
{
  "result": {
    "total": 106,
    "resultList": [
      {
        "fundAccount": "货款提现",
        "createTime": "2026-06-05 21:20:48",
        "withdrawCashAmount": "5200.00(CNY)",
        "withdrawCashStatus": "发起申请",
        "statusCode": 0,
        "beneficiaryAccount": "广发银行 (8583)",
        "withdrawCashAmountFormat": {
          "value": 520000,
          "symbol": "¥",
          "currencyCode": "CNY",
          "digitalText": "5,200.00"
        }
      }
    ]
  }
}
```

当前脚本：

- 先打开资金中心页面建立 Seller Center 登录态和页面 runtime。
- 用 `userInfo` 精确匹配目标店铺 `mallId`。
- 调用 `mall/entity/query` 和 `amount/info` 时带请求头 `mallid: <mallId>`、请求体 `{}`。
- 调用 `withdraw/cash/record` 时同样带请求头 `mallid: <mallId>`，按 `pageSize=100` 翻页拉完整提现记录。
- 由页面 fetch/runtime 自动生成 `Anti-Content`；不要保存或复用抓包里的固定 `Anti-Content`。
- `amount/info` 的 `availableBalance` / `availableBalanceFormat.digitalText` 作为 `可用余额`。
- 提现记录只统计 `withdrawCashStatus` 为 `发起申请` 或 `银行处理中` 的 `withdrawCashAmountFormat.value`。
- 最终 `settledFunds.amountInCents` / `settledFunds.totalAmountText` 是 `可用余额 + 发起申请 + 银行处理中` 的合计。

已验证样例：

- `LEEEV` 店铺 `mallId=634418217285830`。
- `可用余额` 为 `2,049.60`。
- 提现记录中有一笔 `2026-06-05 21:20:48` 的 `发起申请`，金额 `5,200.00`。
- 新口径可提现金额为 `7,249.60`。

入口命令：

```bash
TEMU_ACCOUNT_ID=setonr npm run temu:shop-funds
```

## AgentSeller 结算数据页面 API

待处理款项来自 AgentSeller 结算数据页面。页面入口按店铺类型不同：

- 半托管店铺：欧区 `https://agentseller-eu.temu.com/labor/settle`，美区 `https://agentseller-us.temu.com/labor/settle`。
- 全托管店铺：欧区、美区同上，全球区 `https://agentseller.temu.com/labor/settle`。

脚本会先进入对应页面，遇到 `auth/authentication` 时点击“中国地区 / 商家中心”，再用 Seller Center 授权页的“确认授权并前往”完成授权。弹窗和协议勾选继续使用项目内的 `temu-popup-cleaner.mjs`、`temu-consent-helper.mjs`。

已记录的资金店铺清单：

- 全托管：`Whitine Products`，`SETONR`。
- 半托管：`Whitine Products Global`，`LEEEV Global Outlet`，`LEEEV`，`SETONR Products`，`SETONR Origin`。

### AgentSeller 店铺列表

用途：获取 AgentSeller 侧可见店铺和 `mallId`。同一账号下继续按精确 `mallName` 匹配，不做模糊匹配。

```http
POST /api/seller/auth/userInfo
```

请求体：

```json
{}
```

关键响应字段：

```json
{
  "result": {
    "mallList": [
      {
        "mallId": 634418216263713,
        "mallName": "SETONR Products",
        "managedType": 1,
        "mallMode": 1
      },
      {
        "mallId": 634418224771498,
        "mallName": "SETONR",
        "managedType": 0,
        "mallMode": 0
      }
    ]
  }
}
```

### 半托待处理款项

用途：获取半托店铺的页面标签 `待处理款项总额`。当前接口在欧区、美区域名下相同。

```http
POST /api/xiaowenhou/settle-flow/sm/unsettle/page-query
```

请求体示例：

```json
{
  "pageSize": 1,
  "pageNum": 1,
  "orderCreateTimeStart": "2026-05-07",
  "orderCreateTimeEnd": "2026-06-05"
}
```

关键响应字段：

```json
{
  "result": {
    "total": 5389,
    "totalAmount": {
      "value": 68001631,
      "symbol": "¥",
      "currencyCode": "CNY",
      "digitalText": "680,016.31"
    },
    "productPaymentTotalAmount": {
      "digitalText": "606,813.87"
    },
    "productRefundTotalAmount": {
      "digitalText": "13,141.45"
    },
    "shippingPaymentTotalAmount": {
      "digitalText": "88,049.63"
    },
    "shippingRefundTotalAmount": {
      "digitalText": "2,248.82"
    },
    "dataUpdateTime": "2026-06-05 17:00:00"
  }
}
```

当前脚本规则：

- 分别请求欧区和美区。
- 时间范围取上海日期过去 60 天，拆成两个最多 30 天窗口。
- 日期字段使用 `yyyy-MM-dd` 字符串；毫秒时间戳会返回 `Params invalid`。
- 请求头带 `mallid: <mallId>`，不通过页面可见切店。
- 取各窗口 `totalAmount.value` 相加后格式化为店铺半托 `待处理款项总额`。

### 全托待处理款项

用途：获取全托店铺的页面标签 `预估待结算销售额(CNY)`。

```http
POST /api/merchant/settle/detail/full/wait-settlement
```

请求体：

```json
{}
```

关键响应字段：

```json
{
  "result": {
    "res": {
      "waitSettleAmount": {
        "value": 71532,
        "symbol": "¥",
        "currencyCode": "CNY",
        "digitalText": "715.32"
      }
    }
  }
}
```

当前脚本规则：

- 分别请求欧区、美区、全球区。
- 请求头带 `mallid: <mallId>`。
- 取三域 `res.waitSettleAmount.value` 相加后格式化为全托 `预估待结算销售额(CNY)`。

## 扩展其它 AgentSeller 页面 API 的步骤

### 1. 打开对应页面并确认登录授权

先找到该功能页面的 agentseller 路由，例如：

```text
https://agentseller.temu.com/goods/list
https://agentseller.temu.com/lgst/auth-warehouse/abnormal-order
```

打开页面的目的：

- 复用 Chrome profile 登录态。
- 完成 `auth/authentication` 授权。
- 加载该功能页面对应的 JS chunk。
- 为 `page.evaluate(fetch)` 提供同源上下文。

如果页面进入登录或授权页，要先完成授权；如果触发短信或验证码，需要人工在对应 CDP Chrome profile 里完成后重跑。

### 2. 捕获接口

可以用现有 network capture 机制辅助定位：

```bash
TEMU_CAPTURE_NETWORK=1 npm run temu:agentseller-checks
```

或在新脚本里调用 `createTemuNetworkCapture()` 并 attach 到 CDP context。

定位接口时记录：

- URL 路径。
- 请求方法。
- 请求体。
- 是否需要 `mallid`。
- 是否分页。
- 响应成功码和数据路径。
- 是否需要与其它接口交叉校验。

不要把 cookie、token、sign、password、webhook 等敏感字段写入文档或日志。

### 3. 先拿 mallId，再按 mallid 请求业务接口

通用流程：

```js
const malls = await agentSellerApiResult(page, "/api/seller/auth/userInfo", {}, {}, "店铺列表接口");
const mall = exactMatchMall(malls.mallList, shopName);

const data = await agentSellerApiResult(
  page,
  "/your/new/endpoint",
  requestBody,
  { mallId: mall.mallId },
  `${shopName} 新接口`,
);
```

除非已确认接口与店铺无关，否则默认按店铺传 `mallid`。

### 4. 固化请求体和校验

新增接口不要只保存“能返回数据”的最小代码，应同时记录：

- 固定请求参数的含义。
- 分页参数。
- 总数口径。
- 字段映射。
- 失败时的错误码和错误文本。
- 与页面口径或另一个 API 的交叉校验方式。

例如异常单接口同时使用“数量接口”和“明细接口 totalCount”互相校验，避免静默拿错 tab 或状态。

### 5. 输出 JSON 保留 API 元信息

新增报告 JSON 建议保留：

```json
{
  "source": "direct-api",
  "apiReport": {
    "source": "direct-api",
    "endpoints": {
      "mallList": "https://agentseller.temu.com/api/seller/auth/userInfo",
      "rows": "https://agentseller.temu.com/your/new/endpoint"
    },
    "request": {
      "mallId": "...",
      "pageSize": 100,
      "pages": [1, 2]
    },
    "rowCount": 123
  }
}
```

这样后续排查时可以确认实际调用的接口、页码和数据来源。

## 常见错误和处理

### 401、403、无权限

可能原因：

- Chrome profile 登录态失效。
- agentseller 授权未完成。
- 当前店铺没有该功能权限。
- `mallid` 传错。

处理：

- 先访问对应 agentseller 页面完成授权。
- 重新请求 `userInfo`，确认目标店铺在 `mallList` 中。
- 对无权限要记录 `hasPermission: false` 或明确失败，不要误报为 0。

### API 返回非 JSON

可能原因：

- 被重定向到登录页。
- 风控拦截。
- 请求 URL 或方法不对。
- 页面上下文不是 `agentseller.temu.com`。

处理：

- 看响应 `status` 和 `text` 前 1000 字符。
- 确认 `credentials: "include"`。
- 确认页面 URL 是 agentseller 域下页面。
- 确认 `Anti-Content` 是否生成。

### `Anti-Content` 为空

可能原因：

- 页面 chunk 还没加载。
- chunk 名或模块 id 变了。
- 当前页面不是 AgentSeller 前端应用。

处理：

- 先打开对应功能页面并等待加载完成。
- 检查页面里是否存在 `self["webpackJsonp_bg-agent-seller-lgst"]`。
- 重新在 Network 里确认请求是否仍需要 `Anti-Content`，以及页面 bundle 的风险模块是否变化。

### 页面被关闭

虽然数据走 API，但 CDP 页面仍用于登录态和页面内 fetch。登录/授权跳转可能关闭或替换 tab。

处理：

- 所有等待函数都要容忍 `page.isClosed()`。
- 每次关键跳转后用 `context.pages().filter(page => !page.isClosed())` 重新选择活动页。
- 子脚本按顺序运行，不并发共享同一个 CDP profile。

## 建议的新增脚本结构

新增页面 API 采集脚本时，优先沿用这个结构：

```js
const targetUrl = "https://agentseller.temu.com/your/page";

const { browser, context, page } = await connectCdpChrome(account, targetUrl);
try {
  const activePage = await ensureTargetPage(context, page);
  const malls = await agentSellerApiResult(activePage, "/api/seller/auth/userInfo", {}, {}, "店铺列表接口");

  for (const shopName of shops) {
    const mall = exactMatchMall(malls.mallList, shopName);
    const result = await agentSellerApiResult(
      activePage,
      "/your/api/path",
      { page: 1, pageSize: 100 },
      { mallId: mall.mallId },
      `${shopName} your api`,
    );
    // parse result
  }
} finally {
  await closeCdpPages(context);
  await browser.close().catch(() => {});
  await closeCdpChromeProcess(account.cdpPort);
}
```

关键原则：

- 页面用于授权和同源 API 上下文。
- 店铺靠 `mallid` header 切换。
- 数据靠 JSON 响应解析。
- 精确匹配店名。
- 失败不要静默降级为 0。
- 输出 JSON 里保留接口、请求体、页码、行数和来源。
