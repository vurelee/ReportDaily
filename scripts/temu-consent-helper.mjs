function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function consentPageProbe() {
  const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const isVisible = (node) => {
    if (!node || typeof node.getBoundingClientRect !== "function") return false;
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const checkedByStyle = (node) => {
    if (node instanceof HTMLInputElement) return Boolean(node.checked);
    const aria = node.getAttribute("aria-checked");
    if (aria) return aria === "true";
    const className = String(node.className || "");
    const text = normalize(node.innerText || node.textContent);
    return /checked|selected|active|is-checked/i.test(className) || /^✓|✔/.test(text);
  };
  const consentPattern = /账号ID|店铺名称|各板块共享|已阅读|阅读并同意|隐私政策|协议|授权.*共享|账号使用须知/;
  const checkboxSelectors = [
    'input[type="checkbox"]',
    '[role="checkbox"]',
    '[class*="checkbox"]',
    '[class*="Checkbox"]',
    '[class*="checkBox"]',
    '[class*="CBX"]',
    '[class*="check"]',
    '[class*="Check"]',
  ];
  const selector = checkboxSelectors.join(",");
  const allCheckboxes = Array.from(document.querySelectorAll(selector));
  const visibleCheckboxes = allCheckboxes.filter(isVisible);
  const textNodes = Array.from(document.querySelectorAll("label,div,span,p")).filter((node) => {
    if (!isVisible(node)) return false;
    const rect = node.getBoundingClientRect();
    if (rect.width > 720 || rect.height > 120) return false;
    const text = normalize(node.innerText || node.textContent);
    return consentPattern.test(text) && text.length > 6 && text.length < 500;
  });
  const checkboxText = (node) => {
    const row =
      node.closest("label") ||
      node.closest('[class*="checkbox"]') ||
      node.closest('[class*="Checkbox"]') ||
      node.closest('[class*="checkBox"]') ||
      node.closest('[class*="CBX"]') ||
      node.closest("div");
    return normalize([row?.innerText, node.parentElement?.innerText].filter(Boolean).join(" "));
  };
  const relatedCheckboxes = allCheckboxes.filter((node) => consentPattern.test(checkboxText(node)));
  const smallCheckboxes = visibleCheckboxes.filter((node) => {
    const rect = node.getBoundingClientRect();
    return rect.width <= 44 && rect.height <= 44;
  });
  const candidates = relatedCheckboxes.length > 0 ? relatedCheckboxes : smallCheckboxes;

  return {
    normalize,
    isVisible,
    checkedByStyle,
    consentPattern,
    selector,
    allCheckboxes,
    visibleCheckboxes,
    textNodes,
    candidates,
  };
}

async function consentState(page) {
  return await page.evaluate((probeSource) => {
    const consentPageProbe = new Function(`return (${probeSource})`)();
    const probe = consentPageProbe();
    const needsConsent = probe.textNodes.length > 0 || probe.candidates.length > 0;
    if (!needsConsent) return { needsConsent: false, checked: true };
    const checked = probe.candidates.some(probe.checkedByStyle);
    return { needsConsent: true, checked };
  }, consentPageProbe.toString());
}

async function consentClickTarget(page) {
  return await page.evaluate((probeSource) => {
    const consentPageProbe = new Function(`return (${probeSource})`)();
    const probe = consentPageProbe();
    const center = (rect) => {
      if (rect.width === 0 || rect.height === 0) return { x: rect.left + 8, y: rect.top + 10 };
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    };
    const byPriority = (node) => {
      const text = probe.normalize(node.innerText || node.textContent);
      if (/账号ID|店铺名称|各板块共享/.test(text)) return 0;
      if (/隐私政策|阅读并同意|已阅读/.test(text)) return 1;
      return 2;
    };

    const textNode = [...probe.textNodes].sort((a, b) => byPriority(a) - byPriority(b))[0] || null;
    if (textNode) {
      const textRect = textNode.getBoundingClientRect();
      const sameRow = probe.visibleCheckboxes
        .map((node) => ({ node, rect: node.getBoundingClientRect() }))
        .filter(({ rect }) => {
          const textY = textRect.top + Math.min(18, Math.max(10, textRect.height / 2));
          const centerY = rect.top + rect.height / 2;
          return (
            rect.width <= 44 &&
            rect.height <= 44 &&
            Math.abs(centerY - textY) <= 28 &&
            rect.left < textRect.left + 8 &&
            textRect.left - rect.right <= 90
          );
        })
        .sort((a, b) => textRect.left - b.rect.right - (textRect.left - a.rect.right))[0];
      if (sameRow) return { needsConsent: true, ...center(sameRow.rect), method: "checkbox-left-of-text" };

      const hiddenSameRow = probe.allCheckboxes
        .map((node) => ({ node, rect: node.getBoundingClientRect() }))
        .filter(({ rect }) => {
          const textY = textRect.top + Math.min(18, Math.max(10, textRect.height / 2));
          const anchorY = rect.height === 0 ? rect.top + 10 : rect.top + rect.height / 2;
          return (
            rect.left < textRect.left + 12 &&
            textRect.left - rect.left <= 120 &&
            Math.abs(anchorY - textY) <= 32
          );
        })
        .sort((a, b) => textRect.left - b.rect.left - (textRect.left - a.rect.left))[0];
      if (hiddenSameRow) return { needsConsent: true, ...center(hiddenSameRow.rect), method: "hidden-checkbox-left-of-text" };

      return {
        needsConsent: true,
        x: Math.max(1, textRect.left - 8),
        y: textRect.top + Math.min(18, Math.max(10, textRect.height / 2)),
        method: "text-left-offset",
      };
    }

    const checkbox = probe.candidates[0] || probe.visibleCheckboxes[0] || null;
    if (checkbox) return { needsConsent: true, ...center(checkbox.getBoundingClientRect()), method: "checkbox" };
    return { needsConsent: false };
  }, consentPageProbe.toString());
}

async function clickConsentByDom(page) {
  return await page.evaluate((probeSource) => {
    const consentPageProbe = new Function(`return (${probeSource})`)();
    const probe = consentPageProbe();
    const node =
      probe.candidates[0] ||
      probe.allCheckboxes.find((candidate) => candidate instanceof HTMLInputElement && candidate.type === "checkbox") ||
      probe.allCheckboxes[0] ||
      null;
    if (!node) return false;
    const clickNode =
      node.closest("label") ||
      node.closest('[class*="checkbox"]') ||
      node.closest('[class*="Checkbox"]') ||
      node.closest('[class*="checkBox"]') ||
      node.closest('[class*="CBX"]') ||
      node.parentElement ||
      node;
    clickNode.click();
    return true;
  }, consentPageProbe.toString());
}

export async function consentAppearsChecked(page) {
  const state = await consentState(page);
  return !state.needsConsent || state.checked;
}

export async function ensureConsentChecked(page) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const state = await consentState(page);
    if (!state.needsConsent || state.checked) return true;

    const target = await consentClickTarget(page);
    if (!target.needsConsent) return true;
    if (Number.isFinite(target.x) && Number.isFinite(target.y)) {
      await page.mouse.click(target.x, target.y).catch(() => {});
      await wait(500);
    }

    if (await consentAppearsChecked(page)) return true;

    if (await clickConsentByDom(page).catch(() => false)) {
      await wait(500);
      if (await consentAppearsChecked(page)) return true;
    }
  }

  await page.locator('input[type="checkbox"]').first().check({ force: true, timeout: 1500 }).catch(() => {});
  if (await consentAppearsChecked(page)) return true;

  await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input[type="checkbox"]'));
    for (const input of inputs) {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked");
      descriptor?.set?.call(input, true);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  await wait(500);
  return await consentAppearsChecked(page);
}
