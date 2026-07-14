(() => {
  const CONTENT_VERSION = "1.5.2";
  if (window.__canvaDesignScoreContentVersion === CONTENT_VERSION) return;
  window.__canvaDesignScoreContentVersion = CONTENT_VERSION;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let pageElements = [];
  let pageImages = [];
  let preparedPageCount = 0;
  let preparationPromise = null;

  function timelineRoot() {
    return [...document.querySelectorAll(".PLXBxQ")]
      .find(element => element.querySelector(".JFv1rQ")) || null;
  }

  function timelineScroller(root) {
    if (!root) return null;
    if (root.scrollWidth > root.clientWidth + 4) return root;
    const candidates = [...root.querySelectorAll("div, ul")]
      .filter(element => {
        if (!element.querySelector(".JFv1rQ") || element.clientWidth < 40) return false;
        const overflowX = getComputedStyle(element).overflowX;
        return element.scrollWidth > element.clientWidth + 4 && /auto|hidden|scroll/.test(overflowX);
      })
      .sort((a, b) => (b.scrollWidth - b.clientWidth) - (a.scrollWidth - a.clientWidth));
    return candidates[0] || root;
  }

  function pageNumber(page) {
    const label = page.closest('[data-role="timeline-scene"]')?.getAttribute("aria-label") || "";
    const match = label.match(/(\d+)/);
    return match ? Number(match[1]) : 0;
  }

  function detectedPageCount(root) {
    const numbers = [...root.querySelectorAll('[data-role="timeline-scene"]')]
      .map(scene => Number((scene.getAttribute("aria-label") || "").match(/(\d+)/)?.[1] || 0))
      .filter(Boolean);
    return numbers.length ? Math.max(...numbers) : root.querySelectorAll(".JFv1rQ").length;
  }

  function pageThumbnailImage(page) {
    const firstImage = page?.querySelector("img") || null;
    return firstImage?.classList.contains("vmQN7A") ? firstImage : null;
  }

  function renderedPageReady(page) {
    if (!page?.isConnected) return false;
    const images = [...page.querySelectorAll("img")];
    const hasRenderedContent = images.length > 0 || Boolean(page.querySelector("svg, canvas, p"));
    return hasRenderedContent && images.every(image => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0);
  }

  function collectTimelinePages(root) {
    const pages = [...root.querySelectorAll(".JFv1rQ")];
    pages.forEach((page, fallbackIndex) => {
      const number = pageNumber(page);
      const index = number ? number - 1 : fallbackIndex;
      if (index < 0) return;
      const image = pageThumbnailImage(page);
      const existingPage = pageElements[index];
      if (!existingPage || !existingPage.isConnected || image) pageElements[index] = page;
      if (image) pageImages[index] = image;
    });
    preparedPageCount = Math.max(preparedPageCount, detectedPageCount(root), pageElements.length);
  }

  function presentationTitle() {
    return document.querySelector("input.aWBg0w")?.value?.trim() || document.title || "Canva 디자인 평가 결과";
  }

  async function decodeImage(image, timeoutMs = 1200) {
    if (image.complete && image.naturalWidth > 0 && image.naturalHeight > 0) return true;
    try {
      await Promise.race([
        image.decode(),
        sleep(timeoutMs).then(() => { throw new Error("이미지 로드 대기 시간 초과"); })
      ]);
    } catch {}
    return image.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
  }

  async function scrollTimelineTo(scroller, left) {
    const maxLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
    const nextLeft = Math.max(0, Math.min(maxLeft, Math.round(left)));
    try { scroller.scrollTo({ left: nextLeft, behavior: "auto" }); } catch { scroller.scrollLeft = nextLeft; }
    if (Math.abs(scroller.scrollLeft - nextLeft) > 2) scroller.scrollLeft = nextLeft;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await sleep(180);
  }

  function horizontallyVisible(page, scroller) {
    if (!page?.isConnected) return false;
    const pageRect = page.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    return pageRect.right > scrollerRect.left && pageRect.left < scrollerRect.right;
  }

  async function settleVisibleThumbnails(root, scroller) {
    const deadline = Date.now() + 720;
    do {
      collectTimelinePages(root);
      const visiblePages = pageElements.filter(page => horizontallyVisible(page, scroller));
      const visibleImages = visiblePages.flatMap(page => [...page.querySelectorAll("img")]);
      await Promise.all(visibleImages.map(image => decodeImage(image, 420)));
      if (visiblePages.length && visiblePages.every(page => {
        const thumbnail = pageThumbnailImage(page);
        return (thumbnail?.complete && thumbnail.naturalWidth > 0) || renderedPageReady(page);
      })) break;
      await sleep(90);
    } while (Date.now() < deadline);
    collectTimelinePages(root);
  }

  function reportTimelineProgress(completedRatio, loaded, total) {
    chrome.runtime.sendMessage({
      type: "PAGE_LOAD_PROGRESS",
      percent: 2 + Math.round(Math.max(0, Math.min(1, completedRatio)) * 10),
      message: `.PLXBxQ 타임라인을 가로 스크롤하며 페이지 이미지 로드 중 (${loaded}/${total})`
    }).catch(() => {});
  }

  async function sweepTimeline(root, scroller) {
    pageElements = [];
    pageImages = [];
    preparedPageCount = 0;
    collectTimelinePages(root);

    for (let pass = 0; pass < 2; pass++) {
      const maxLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
      const step = Math.max(120, Math.round(scroller.clientWidth * 0.72));
      const positions = [];
      if (pass === 0) {
        for (let left = 0; left < maxLeft; left += step) positions.push(left);
        positions.push(maxLeft);
      } else {
        for (let left = maxLeft; left > 0; left -= step) positions.push(left);
        positions.push(0);
      }

      for (let positionIndex = 0; positionIndex < positions.length; positionIndex++) {
        await scrollTimelineTo(scroller, positions[positionIndex]);
        await settleVisibleThumbnails(root, scroller);
        const loaded = pageImages.filter(image => image?.complete && image.naturalWidth > 0).length;
        const ratio = (pass + ((positionIndex + 1) / positions.length)) / 2;
        reportTimelineProgress(ratio, loaded, preparedPageCount);
      }

      const knownPages = pageElements.slice(0, preparedPageCount).filter(Boolean).length;
      const loadedImages = pageImages.slice(0, preparedPageCount).filter(image => image?.complete && image.naturalWidth > 0).length;
      if (knownPages === preparedPageCount && loadedImages === preparedPageCount) break;
    }
  }

  async function preparePages() {
    const root = timelineRoot();
    if (!root) {
      const pages = [...document.querySelectorAll(".JFv1rQ")];
      pageElements = pages;
      pageImages = pages.map(pageThumbnailImage);
      preparedPageCount = pages.length;
      return;
    }
    await sweepTimeline(root, timelineScroller(root));
  }

  async function ensurePagesPrepared() {
    if (!preparationPromise) {
      preparationPromise = preparePages().finally(() => { preparationPromise = null; });
    }
    await preparationPromise;
  }

  async function revealPage(index) {
    const root = timelineRoot();
    const scroller = timelineScroller(root);
    let page = pageElements[index];
    if (!root || !scroller) return page || null;

    if (page?.isConnected) {
      const pageRect = page.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      const targetLeft = scroller.scrollLeft + pageRect.left - scrollerRect.left - (scrollerRect.width - pageRect.width) / 2;
      await scrollTimelineTo(scroller, targetLeft);
    } else {
      const maxLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
      const targetLeft = preparedPageCount > 1 ? maxLeft * index / (preparedPageCount - 1) : 0;
      await scrollTimelineTo(scroller, targetLeft);
    }

    await settleVisibleThumbnails(root, scroller);
    page = pageElements[index] || page;
    return page || null;
  }

  async function pagePreview(index) {
    let page = await revealPage(index);
    const startedAt = Date.now();
    while (Date.now() - startedAt < 4000) {
      const image = pageThumbnailImage(page) || pageImages[index] || null;
      if (image && await decodeImage(image)) return { page, image };
      if (renderedPageReady(page)) return { page, image: null };
      page = await revealPage(index);
      await sleep(120);
    }
    return { page, image: null };
  }

  function elementRect(element) {
    const rect = element.getBoundingClientRect();
    return {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight
    };
  }

  function pageCloneFilter(page) {
    return element => {
      const tagName = element?.tagName || "";
      if (tagName === "SCRIPT" || tagName === "NOSCRIPT") return true;
      if (tagName === "LINK") {
        const rel = (element.getAttribute("rel") || "").toLowerCase();
        const as = (element.getAttribute("as") || "").toLowerCase();
        if (rel === "modulepreload" || as === "script") return true;
      }
      try {
        return element !== page && !element.contains(page) && !page.contains(element);
      } catch {
        return false;
      }
    };
  }

  function cleanClonedDocument(clonedDocument) {
    clonedDocument
      .querySelectorAll('script, noscript, link[rel="modulepreload"], link[as="script"]')
      .forEach(element => element.remove());
  }

  async function withFrequentCanvasReads(operation) {
    const prototype = globalThis.HTMLCanvasElement?.prototype;
    const originalGetContext = prototype?.getContext;
    if (typeof originalGetContext !== "function") return operation();
    const patchedGetContext = function(type, options) {
      if (type === "2d" && options === undefined) {
        return originalGetContext.call(this, type, { willReadFrequently: true });
      }
      return originalGetContext.call(this, type, options);
    };
    try {
      prototype.getContext = patchedGetContext;
    } catch {
      return operation();
    }
    try {
      return await operation();
    } finally {
      if (prototype.getContext === patchedGetContext) prototype.getContext = originalGetContext;
    }
  }

  async function renderedPageToPng(page, targetWidth) {
    if (!page?.isConnected) throw new Error("페이지 미리보기 요소가 현재 문서에서 분리되었습니다.");
    if (typeof globalThis.html2canvas !== "function") throw new Error("페이지 내부 PNG 렌더러를 불러오지 못했습니다.");
    if (document.fonts?.ready) await Promise.race([document.fonts.ready, sleep(1400)]).catch(() => {});

    const rect = page.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 24) throw new Error("페이지 미리보기 영역이 너무 작습니다.");
    const scale = Math.max(1, targetWidth / rect.width);
    let canvas;
    let firstError;
    for (const foreignObjectRendering of [false, true]) {
      try {
        canvas = await withFrequentCanvasReads(() => globalThis.html2canvas(page, {
          allowTaint: false,
          backgroundColor: "#ffffff",
          foreignObjectRendering,
          imageTimeout: 6500,
          ignoreElements: pageCloneFilter(page),
          logging: false,
          onclone: cleanClonedDocument,
          removeContainer: true,
          scale,
          useCORS: true
        }));
        if (canvas.width > 0 && canvas.height > 0) break;
      } catch (error) {
        firstError ||= error;
        canvas = null;
      }
    }
    if (!canvas) throw firstError || new Error("페이지 내부 PNG 렌더링 결과가 비어 있습니다.");

    const width = targetWidth;
    const height = Math.max(1, Math.round(canvas.height * width / canvas.width));
    if (canvas.width === width && canvas.height === height) return canvas.toDataURL("image/png");
    const resized = document.createElement("canvas");
    resized.width = width;
    resized.height = height;
    const context = resized.getContext("2d", { alpha: false });
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(canvas, 0, 0, width, height);
    return resized.toDataURL("image/png");
  }

  function imageToPng(image, targetWidth) {
    const ratio = image.naturalHeight / image.naturalWidth;
    const width = targetWidth;
    const height = Math.max(1, Math.round(width * ratio));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, width, height);
    return canvas.toDataURL("image/png");
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "GET_PAGES") {
      (async () => {
        await ensurePagesPrepared();
        const missingPages = [];
        for (let index = 0; index < preparedPageCount; index++) {
          if (!pageElements[index]) missingPages.push(index + 1);
        }
        if (missingPages.length) {
          sendResponse({ error: `타임라인을 끝까지 스크롤했지만 ${missingPages.join(", ")}페이지를 찾지 못했습니다.` });
          return;
        }
        sendResponse({
          count: preparedPageCount,
          title: presentationTitle(),
          selector: ".JFv1rQ",
          timelineSelector: ".PLXBxQ",
          loadedPageImages: pageImages.slice(0, preparedPageCount).filter(image => image?.complete && image.naturalWidth > 0).length,
          renderedPageFallbacks: pageElements.slice(0, preparedPageCount).filter((page, index) => page && !pageImages[index]).length
        });
      })().catch(error => sendResponse({ error: error.message || String(error) }));
      return true;
    }

    if (message.type === "GET_PRESENTATION_TITLE") {
      sendResponse({ title: presentationTitle() });
      return;
    }

    if (message.type === "EXPORT_PAGE_IMAGE") {
      (async () => {
        if (!preparedPageCount) await ensurePagesPrepared();
        const { page, image } = await pagePreview(message.index);
        if (!page && !image) {
          sendResponse({ error: `${message.index + 1}페이지의 .JFv1rQ 요소를 찾지 못했습니다.` });
          return;
        }
        if (!image) {
          try {
            sendResponse({
              dataUrl: await renderedPageToPng(page, message.targetWidth),
              renderedPageInContent: true
            });
          } catch (renderError) {
            sendResponse({
              fallbackRect: elementRect(page),
              renderedPageFallback: true,
              renderError: renderError.message || String(renderError)
            });
          }
          return;
        }
        try {
          sendResponse({
            dataUrl: imageToPng(image, message.targetWidth),
            naturalWidth: image.naturalWidth,
            naturalHeight: image.naturalHeight
          });
        } catch (error) {
          try {
            sendResponse({
              dataUrl: await renderedPageToPng(page, message.targetWidth),
              renderedPageInContent: true,
              canvasError: error.message
            });
          } catch (renderError) {
            sendResponse({
              fallbackRect: elementRect(image),
              imageSrc: image.currentSrc || image.src || "",
              naturalWidth: image.naturalWidth,
              naturalHeight: image.naturalHeight,
              canvasError: error.message,
              renderError: renderError.message || String(renderError)
            });
          }
        }
      })().catch(error => sendResponse({ error: error.message || String(error) }));
      return true;
    }
  });
})();
