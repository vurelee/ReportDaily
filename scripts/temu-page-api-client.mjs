const DEFAULT_HEADERS = {
  accept: "application/json, text/plain, */*",
  "content-type": "application/json",
};

function endpointUrl(origin, endpoint) {
  if (String(endpoint || "").startsWith("http")) return String(endpoint);
  return new URL(String(endpoint || ""), origin).toString();
}

export async function temuPageRequest(page, {
  origin,
  endpoint,
  body = undefined,
  mallId = "",
  label = "Temu page API",
  headers = {},
  method = "POST",
  timeoutMs = 0,
} = {}) {
  if (!page || page.isClosed()) {
    throw new Error(`${label}: page is closed before requesting ${endpoint || "unknown endpoint"}`);
  }
  if (!origin && !String(endpoint || "").startsWith("http")) {
    throw new Error(`${label}: origin is required for relative endpoint ${endpoint || "unknown endpoint"}`);
  }

  const url = endpointUrl(origin, endpoint);
  const hasBody = body !== undefined;

  try {
    return await page.evaluate(
      async ({ url, endpoint, body, hasBody, mallId, label, extraHeaders, method, timeoutMs }) => {
        async function antiContentValue() {
          try {
            if (!window.__codexTemuChunkRequire) {
              const factories = {};
              for (const chunkName of ["webpackJsonp_bg-agent-seller-lgst", "webpackJsonp_mms_seller_bg_pc_mms", "webpackJsonp"]) {
                for (const chunk of self[chunkName] || []) {
                  const modules = chunk?.[1];
                  if (!modules || typeof modules !== "object") continue;
                  Object.assign(factories, modules);
                }
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

        const requestHeaders = {
          ...extraHeaders,
        };
        const antiContent = await antiContentValue();
        if (antiContent) requestHeaders["Anti-Content"] = antiContent;
        if (mallId) requestHeaders.mallid = String(mallId);

        const controller = timeoutMs > 0 ? new AbortController() : null;
        const timeoutId = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
        let response;
        try {
          response = await fetch(url, {
            method,
            credentials: "include",
            headers: requestHeaders,
            signal: controller?.signal,
            ...(hasBody ? { body: JSON.stringify(body || {}) } : {}),
          });
        } finally {
          if (timeoutId) clearTimeout(timeoutId);
        }
        const bodyText = await response.text();
        let json = null;
        try {
          json = bodyText ? JSON.parse(bodyText) : null;
        } catch {
          json = null;
        }

        return {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          url: response.url,
          endpoint,
          label,
          bodyText,
          json,
        };
      },
      {
        url,
        endpoint,
        body,
        hasBody,
        mallId,
        label,
        method,
        timeoutMs,
        extraHeaders: { ...DEFAULT_HEADERS, ...headers },
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}: ${endpoint} request failed: ${message}`);
  }
}

export async function temuPageApiPost(page, options = {}) {
  return await temuPageRequest(page, { ...options, method: "POST" });
}
