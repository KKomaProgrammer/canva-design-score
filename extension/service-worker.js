const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const MIN_CAPTURE_INTERVAL_MS = 850;
let lastCaptureAt = 0;

async function setState(state) {
  await chrome.storage.local.set({ analysisState: { updatedAt: Date.now(), ...state } });
}

function sendToTab(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function automaticImageWidth(pageCount) {
  const calculated = 1280 * Math.sqrt(6 / Math.max(1, pageCount));
  const limited = Math.max(512, Math.min(1280, calculated));
  return Math.max(512, Math.floor(limited / 32) * 32);
}

async function captureVisibleTabSafely(windowId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const waitMs = Math.max(0, MIN_CAPTURE_INTERVAL_MS - (Date.now() - lastCaptureAt));
    if (waitMs) await sleep(waitMs);
    try {
      lastCaptureAt = Date.now();
      return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
    } catch (error) {
      const isQuotaError = /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota/i.test(error.message || String(error));
      if (!isQuotaError || attempt === 4) throw error;
      await sleep(1000 * (attempt + 1));
    }
  }
  throw new Error("화면 캡처 호출 제한으로 이미지를 가져오지 못했습니다.");
}

async function cropScreenshot(dataUrl, rect, targetWidth) {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const sxScale = bitmap.width / rect.viewportWidth;
  const syScale = bitmap.height / rect.viewportHeight;
  const sx = Math.max(0, Math.round(rect.x * sxScale));
  const sy = Math.max(0, Math.round(rect.y * syScale));
  const sw = Math.min(bitmap.width - sx, Math.round(rect.width * sxScale));
  const sh = Math.min(bitmap.height - sy, Math.round(rect.height * syScale));
  if (sw < 40 || sh < 24) throw new Error("첫 번째 img 요소의 캡처 영역이 너무 작습니다.");
  const width = targetWidth;
  const height = Math.max(1, Math.round(sh * width / sw));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d", { alpha: false });
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, sx, sy, sw, sh, 0, 0, width, height);
  bitmap.close();
  const png = await canvas.convertToBlob({ type: "image/png" });
  return `data:image/png;base64,${bufferToBase64(await png.arrayBuffer())}`;
}

async function getPageInfo(tabId) {
  try {
    return await sendToTab(tabId, { type: "GET_PAGES" });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return sendToTab(tabId, { type: "GET_PAGES" });
  }
}

async function captureSlides(tab) {
  const info = await getPageInfo(tab.id);
  if (!info?.count) {
    throw new Error(".JFv1rQ 요소를 찾지 못했습니다. Canva의 페이지 목록이 열린 상태에서 다시 시도해 주세요.");
  }

  const targetWidth = automaticImageWidth(info.count);
  const images = [];
  for (let index = 0; index < info.count; index++) {
    await setState({
      status: "running",
      percent: Math.round((index / info.count) * 65),
      message: `${index + 1}/${info.count} 페이지의 첫 번째 img를 ${targetWidth}px PNG로 변환 중`
    });
    const exported = await sendToTab(tab.id, { type: "EXPORT_PAGE_IMAGE", index, targetWidth });
    if (exported?.error) throw new Error(exported.error);
    if (exported?.dataUrl) {
      images.push(exported.dataUrl);
      continue;
    }
    const rect = exported?.fallbackRect;
    if (!rect) throw new Error(`${index + 1}페이지의 첫 번째 img를 PNG로 변환하지 못했습니다.`);
    await sleep(120);
    if (rect.x < -2 || rect.y < -2 || rect.x + rect.width > rect.viewportWidth + 2 || rect.y + rect.height > rect.viewportHeight + 2) {
      throw new Error(`${index + 1}페이지의 첫 번째 img가 화면에 완전히 보이지 않아 대체 캡처할 수 없습니다.`);
    }
    const screenshot = await captureVisibleTabSafely(tab.windowId);
    images.push(await cropScreenshot(screenshot, rect, targetWidth));
  }

  if (images.length !== info.count) {
    throw new Error(`전체 페이지 변환에 실패했습니다. 발견 ${info.count}개, 변환 ${images.length}개`);
  }
  return { images, title: info.title, targetWidth, pageCount: info.count };
}

async function runAnalysis(settings) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https:\/\/www\.canva\.com\/design\//.test(tab.url || "")) {
      throw new Error("Canva 디자인 편집 페이지에서 실행해 주세요.");
    }
    await setState({ status: "running", percent: 2, message: ".JFv1rQ 페이지 요소 검색 중" });
    const { images, title, targetWidth } = await captureSlides(tab);
    await setState({
      status: "running",
      percent: 72,
      message: `전체 ${images.length}페이지(${targetWidth}px PNG)를 ${settings.model === "gpt-5.6-terra" ? "Terra" : "Luna"}로 평가 중`
    });
    const response = await fetch(settings.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(settings.token ? { "X-Access-Token": settings.token } : {})
      },
      body: JSON.stringify({ model: settings.model, title, images })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `API 오류 (${response.status})`);
    await setState({
      status: "done",
      percent: 100,
      message: "평가 완료",
      result: { ...data, presentation_title: title }
    });
  } catch (error) {
    await setState({ status: "error", percent: 0, error: error.message || String(error) });
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "START_ANALYSIS") return;
  chrome.storage.local.get("analysisState").then(({ analysisState }) => {
    if (analysisState?.status === "running" && Date.now() - analysisState.updatedAt < 5 * 60 * 1000) {
      sendResponse({ ok: false, error: "이미 분석이 진행 중입니다." });
      return;
    }
    sendResponse({ ok: true });
    runAnalysis(message.settings);
  });
  return true;
});
