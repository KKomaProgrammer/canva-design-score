const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function setState(state) {
  await chrome.storage.local.set({ analysisState: { updatedAt: Date.now(), ...state } });
}

function sendToTab(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
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
  if (sw < 100 || sh < 60) throw new Error("슬라이드 캡처 영역이 너무 작습니다. Canva에서 슬라이드가 보이도록 확대/축소를 조정해 주세요.");
  const width = Math.min(targetWidth, sw);
  const height = Math.max(1, Math.round(sh * width / sw));
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext("2d", { alpha: false }).drawImage(bitmap, sx, sy, sw, sh, 0, 0, width, height);
  bitmap.close();
  const png = await canvas.convertToBlob({ type: "image/png" });
  return `data:image/png;base64,${bufferToBase64(await png.arrayBuffer())}`;
}

async function captureSlides(tab, targetWidth) {
  let info;
  try { info = await sendToTab(tab.id, { type: "GET_PAGES" }); }
  catch {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    info = await sendToTab(tab.id, { type: "GET_PAGES" });
  }
  if (!info?.count) throw new Error("Canva 슬라이드를 찾지 못했습니다. 편집 화면에서 슬라이드가 보이는 상태로 다시 시도해 주세요.");
  const images = [];
  for (let index = 0; index < info.count; index++) {
    await setState({ status: "running", percent: Math.round((index / info.count) * 65), message: `${index + 1}/${info.count} 페이지 PNG 캡처 중` });
    const prepared = await sendToTab(tab.id, { type: "PREPARE_PAGE", index });
    if (prepared?.error) throw new Error(prepared.error);
    await sleep(350);
    const latest = await sendToTab(tab.id, { type: "GET_PAGE_RECT", index });
    const rect = latest?.rect || prepared?.rect;
    if (!rect) throw new Error(`${index + 1}페이지 위치를 읽지 못했습니다.`);
    if (rect.x < -2 || rect.y < -2 || rect.x + rect.width > rect.viewportWidth + 2 || rect.y + rect.height > rect.viewportHeight + 2) {
      throw new Error(`${index + 1}페이지가 화면에 완전히 들어오지 않습니다. Canva 확대/축소에서 '페이지 맞춤'을 선택해 주세요.`);
    }
    const screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    images.push(await cropScreenshot(screenshot, rect, targetWidth));
  }
  return { images, title: info.title };
}

async function runAnalysis(settings) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https:\/\/www\.canva\.com\/design\//.test(tab.url || "")) throw new Error("Canva 디자인 편집 페이지에서 실행해 주세요.");
    await setState({ status: "running", percent: 2, message: "Canva 페이지 검색 중" });
    const { images, title } = await captureSlides(tab, Number(settings.width) || 960);
    await setState({ status: "running", percent: 72, message: `${images.length}개 PNG를 ${settings.model === "gpt-5.6-terra" ? "Terra" : "Luna"}로 평가 중` });
    const response = await fetch(settings.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(settings.token ? { "X-Access-Token": settings.token } : {}) },
      body: JSON.stringify({ model: settings.model, title, images })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `API 오류 (${response.status})`);
    await setState({ status: "done", percent: 100, message: "평가 완료", result: data });
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

