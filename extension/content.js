(() => {
  if (window.__canvaDesignScoreContentLoaded) return;
  window.__canvaDesignScoreContentLoaded = true;

  function findPages() {
    const pages = [...document.querySelectorAll(".JFv1rQ")];
    window.__canvaDesignScorePages = pages;
    return pages;
  }

  function presentationTitle() {
    return document.querySelector("input.aWBg0w")?.value?.trim() || document.title || "Canva 디자인 평가 결과";
  }

  async function firstImage(page) {
    page.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
    const startedAt = Date.now();
    while (Date.now() - startedAt < 4000) {
      const image = page.querySelector("img");
      if (image) {
        if (!image.complete || !image.naturalWidth) {
          try { await image.decode(); } catch {}
        }
        if (image.complete && image.naturalWidth > 0 && image.naturalHeight > 0) return image;
      }
      await new Promise(resolve => setTimeout(resolve, 120));
    }
    return null;
  }

  function imageRect(image) {
    const rect = image.getBoundingClientRect();
    return {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight
    };
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
      const pages = findPages();
      sendResponse({
        count: pages.length,
        title: presentationTitle(),
        selector: ".JFv1rQ",
        imagesNow: pages.filter(page => page.querySelector("img")).length
      });
      return;
    }

    if (message.type === "GET_PRESENTATION_TITLE") {
      sendResponse({ title: presentationTitle() });
      return;
    }

    if (message.type === "EXPORT_PAGE_IMAGE") {
      (async () => {
        const pages = window.__canvaDesignScorePages || findPages();
        const page = pages[message.index];
        if (!page) {
          sendResponse({ error: `${message.index + 1}페이지의 .JFv1rQ 요소를 찾지 못했습니다.` });
          return;
        }
        const image = await firstImage(page);
        if (!image) {
          sendResponse({ error: `${message.index + 1}페이지 .JFv1rQ 안의 첫 번째 img를 불러오지 못했습니다.` });
          return;
        }
        try {
          sendResponse({
            dataUrl: imageToPng(image, message.targetWidth),
            naturalWidth: image.naturalWidth,
            naturalHeight: image.naturalHeight
          });
        } catch (error) {
          sendResponse({
            fallbackRect: imageRect(image),
            naturalWidth: image.naturalWidth,
            naturalHeight: image.naturalHeight,
            canvasError: error.message
          });
        }
      })();
      return true;
    }
  });
})();
