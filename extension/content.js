(() => {
  if (window.__canvaDesignScoreContentLoaded) return;
  window.__canvaDesignScoreContentLoaded = true;

  function visible(element) {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 120 && rect.height > 70;
  }

  function scoreCandidate(element) {
    const rect = element.getBoundingClientRect();
    const ratio = rect.width / rect.height;
    let score = 0;
    if (element.classList.contains("_mXnjA")) score += 100;
    if (/width:\s*1920px/i.test(element.getAttribute("style") || "")) score += 40;
    if (/height:\s*1080px/i.test(element.getAttribute("style") || "")) score += 40;
    if (ratio > 1.2 && ratio < 2.1) score += 15;
    if (rect.width * rect.height > 50000) score += 10;
    return score;
  }

  function findPages() {
    const selectors = ["div._mXnjA", "[data-page-id]", "[data-testid*='page']", "[aria-label^='Page ']"];
    const candidates = [...new Set(selectors.flatMap(selector => [...document.querySelectorAll(selector)]))]
      .filter(visible)
      .map(element => ({ element, score: scoreCandidate(element) }))
      .filter(item => item.score >= 20)
      .sort((a, b) => {
        const ar = a.element.getBoundingClientRect();
        const br = b.element.getBoundingClientRect();
        return (ar.top + scrollY) - (br.top + scrollY) || ar.left - br.left;
      });
    const pages = [];
    for (const item of candidates) {
      if (pages.some(page => page.contains(item.element) || item.element.contains(page))) {
        const existingIndex = pages.findIndex(page => page.contains(item.element) || item.element.contains(page));
        if (item.score > scoreCandidate(pages[existingIndex])) pages[existingIndex] = item.element;
      } else pages.push(item.element);
    }
    if (!pages.length) {
      const fallback = [...document.querySelectorAll("div")].filter(element => {
        const rect = element.getBoundingClientRect();
        const ratio = rect.width / rect.height;
        return visible(element) && ratio > 1.5 && ratio < 1.9 && rect.width > 400 && element.querySelectorAll("img,svg,p").length >= 2;
      }).sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
      if (fallback) pages.push(fallback);
    }
    window.__canvaDesignScorePages = pages.slice(0, 30);
    return window.__canvaDesignScorePages;
  }

  function rectFor(page) {
    const rect = page.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height, viewportWidth: innerWidth, viewportHeight: innerHeight, dpr: devicePixelRatio };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "GET_PAGES") {
      const pages = findPages();
      sendResponse({ count: pages.length, title: document.title });
      return;
    }
    if (message.type === "PREPARE_PAGE") {
      const pages = window.__canvaDesignScorePages?.length ? window.__canvaDesignScorePages : findPages();
      const page = pages[message.index];
      if (!page) { sendResponse({ error: "페이지를 찾지 못했습니다." }); return; }
      page.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
      setTimeout(() => sendResponse({ rect: rectFor(page) }), 450);
      return true;
    }
    if (message.type === "GET_PAGE_RECT") {
      const page = window.__canvaDesignScorePages?.[message.index];
      sendResponse(page ? { rect: rectFor(page) } : { error: "페이지를 찾지 못했습니다." });
    }
  });
})();

