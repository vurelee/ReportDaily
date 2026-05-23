const popupSelectors = {
  surveyContainer: 'div[class*="satisfaction-score_container"]',
  surveyClose: 'div[class*="satisfaction-score_container"] svg[data-testid="beast-core-icon-close"]',
  messageBellHeader: "div[class*=popoverWithTitle] div[class^=new-bell_header]",
  messageClose: 'div[class*=popoverWithTitle] div[class^=new-bell_header] svg[data-testid="beast-core-icon-close"]',
  modalBodyDivs: "body > div:not([data-disabled=disabled])",
};

export async function closeTemuPopups(page) {
  return await page
    .evaluate((selectors) => {
      const result = {
        clicked: 0,
        hidden: 0,
        watermarksHidden: false,
        foundSurvey: false,
        foundMessageBell: false,
        foundModal: false,
        errors: [],
      };

      const isVisible = (dom) => {
        if (!dom) return false;
        const rect = dom.getBoundingClientRect();
        const style = window.getComputedStyle(dom);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };

      const clickClose = (selector) => {
        const closeBtn = document.querySelector(selector);
        if (!closeBtn || !isVisible(closeBtn)) return false;
        try {
          closeBtn.dispatchEvent(new MouseEvent("click", { view: window, bubbles: true, cancelable: true }));
          if (typeof closeBtn.click === "function") closeBtn.click();
          result.clicked += 1;
          return true;
        } catch (error) {
          result.errors.push(String(error?.message || error));
          return false;
        }
      };

      const injectWatermarkKiller = () => {
        if (document.getElementById("temu-watermark-killer")) return false;
        const style = document.createElement("style");
        style.id = "temu-watermark-killer";
        style.textContent = `
          [id^="c_express"] {
            opacity: 0 !important;
            visibility: hidden !important;
            background-image: none !important;
            pointer-events: none !important;
          }
          div[style*="z-index: 2147483647"],
          div[style*="pointer-events: none"][style*="position: fixed"][style*="background: url"] {
            opacity: 0 !important;
            background: transparent !important;
            background-image: none !important;
            display: none !important;
          }
        `;
        document.documentElement.appendChild(style);
        return true;
      };

      const getActiveModals = () => {
        const coreDoms = [];
        const maskDoms = [];
        document.querySelectorAll(selectors.modalBodyDivs).forEach((dom) => {
          const className = String(dom.className || "");
          if (!className || !isVisible(dom)) return;
          if (
            className.includes("MDL_alert") ||
            className.includes("MDL_outerWrapper") ||
            className.includes("MDL_modal")
          ) {
            coreDoms.push(dom);
          } else if (className.includes("MDL_mask")) {
            maskDoms.push(dom);
          }
        });
        return { coreDoms, maskDoms };
      };

      const hideDom = (dom) => {
        if (!dom) return;
        dom.style.display = "none";
        dom.setAttribute("data-disabled", "disabled");
        result.hidden += 1;
      };

      result.foundSurvey = Boolean(document.querySelector(selectors.surveyContainer));
      result.foundMessageBell = Boolean(document.querySelector(selectors.messageBellHeader));
      result.watermarksHidden = injectWatermarkKiller();
      clickClose(selectors.messageClose);
      clickClose(selectors.surveyClose);

      const { coreDoms, maskDoms } = getActiveModals();
      result.foundModal = coreDoms.length > 0;
      coreDoms.forEach((dom, index) => {
        hideDom(dom);
        hideDom(maskDoms[index]);
      });

      return result;
    }, popupSelectors)
    .catch((error) => ({
      clicked: 0,
      hidden: 0,
      watermarksHidden: false,
      foundSurvey: false,
      foundMessageBell: false,
      foundModal: false,
      errors: [String(error?.message || error)],
    }));
}
