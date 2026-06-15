function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function mallListCandidates(payload) {
  if (Array.isArray(payload)) return [payload];

  const roots = [
    payload,
    payload?.result,
    payload?.data,
    payload?.json,
    payload?.json?.result,
    payload?.body,
    payload?.body?.result,
  ];
  return roots
    .flatMap((root) => [
      root?.mallList,
      root?.mall_list,
      root?.query_mall_detail_resp_dtolist,
      ...(Array.isArray(root?.companyList) ? root.companyList.map((company) => company?.malInfoList) : []),
      ...(Array.isArray(root?.company_list) ? root.company_list.map((company) => company?.mall_info_list) : []),
    ])
    .filter((value) => Array.isArray(value));
}

export function extractMallList(payload) {
  for (const candidate of mallListCandidates(payload)) {
    if (candidate.length > 0) return candidate;
  }
  return [];
}

export function resolveMallByExactName(payload, targetMallName) {
  const target = cleanText(targetMallName);
  const malls = extractMallList(payload);
  if (malls.length === 0) {
    throw new Error(`店铺列表接口没有返回可切换店铺：${target}`);
  }

  const matches = malls.filter((mall) => cleanText(mall?.mallName ?? mall?.mall_name) === target);
  if (matches.length !== 1) {
    throw new Error(`店铺列表接口中找不到唯一精确店名：${target}；匹配数=${matches.length}`);
  }

  const mall = matches[0];
  const mallId = String(mall?.mallId ?? mall?.mall_id ?? "");
  if (!mallId) {
    throw new Error(`店铺列表接口中 ${target} 缺少 mallId`);
  }

  return {
    mallId,
    mallName: cleanText(mall.mallName ?? mall.mall_name),
    raw: mall,
  };
}

export function resolveMallByName(payload, targetMallName, options = {}) {
  const target = cleanText(targetMallName);
  const malls = extractMallList(payload);
  if (malls.length === 0) {
    throw new Error(`店铺列表接口没有返回可切换店铺：${target}`);
  }

  const normalize = options.caseInsensitive
    ? (value) => cleanText(value).toLowerCase()
    : cleanText;
  const normalizedTarget = normalize(target);
  const matches = malls.filter((mall) => normalize(mall?.mallName ?? mall?.mall_name) === normalizedTarget);
  if (matches.length !== 1) {
    throw new Error(`店铺列表接口中找不到唯一店名：${target}；匹配数=${matches.length}`);
  }

  const mall = matches[0];
  const mallId = String(mall?.mallId ?? mall?.mall_id ?? "");
  const mallName = cleanText(mall.mallName ?? mall.mall_name);
  if (!mallId) {
    throw new Error(`店铺列表接口中 ${mallName || target} 缺少 mallId`);
  }

  return {
    mallId,
    mallName,
    raw: mall,
  };
}
