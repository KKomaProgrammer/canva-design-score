const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const MIN_CAPTURE_INTERVAL_MS = 850;
const MAX_HISTORY_ITEMS = 40;
const MAX_HISTORY_BYTES = 3 * 1024 * 1024;
const MAX_TRASH_ITEMS = 60;
const MAX_TRASH_BYTES = 3 * 1024 * 1024;
let lastCaptureAt = 0;
let historyMutation = Promise.resolve();

async function setState(state) {
  await chrome.storage.local.set({ analysisState: { updatedAt: Date.now(), ...state } });
}

function collectionBytes(items) {
  return new TextEncoder().encode(JSON.stringify(items)).byteLength;
}

function trimCollection(items, maxItems, maxBytes) {
  const removed = [];
  while (items.length > maxItems || (items.length > 1 && collectionBytes(items) > maxBytes)) {
    removed.push(items.pop());
  }
  return removed;
}

function addToTrash(trash, entries) {
  const now = Date.now();
  const moved = entries.map(entry => ({ ...entry, trashedAt: now }));
  const nextTrash = [...moved, ...trash];
  trimCollection(nextTrash, MAX_TRASH_ITEMS, MAX_TRASH_BYTES);
  return nextTrash;
}

function queueHistoryMutation(operation) {
  const next = historyMutation.then(operation, operation);
  historyMutation = next.catch(() => {});
  return next;
}

async function saveHistory(result) {
  return queueHistoryMutation(async () => {
    const stored = await chrome.storage.local.get({ analysisHistory: [], analysisTrash: [] });
    const entry = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      title: result.presentation_title || "제목 없는 프레젠테이션",
      score: result.deck_score,
      grade: result.deck_grade,
      result
    };
    const history = [entry, ...stored.analysisHistory];
    const evicted = trimCollection(history, MAX_HISTORY_ITEMS, MAX_HISTORY_BYTES);
    const analysisTrash = addToTrash(stored.analysisTrash, evicted);
    await chrome.storage.local.set({ analysisHistory: history, analysisTrash });
  });
}

async function moveHistoryToTrash(id) {
  return queueHistoryMutation(async () => {
    const stored = await chrome.storage.local.get({ analysisHistory: [], analysisTrash: [] });
    const moving = id ? stored.analysisHistory.filter(entry => entry.id === id) : stored.analysisHistory;
    const analysisHistory = id ? stored.analysisHistory.filter(entry => entry.id !== id) : [];
    const analysisTrash = addToTrash(stored.analysisTrash, moving);
    await chrome.storage.local.set({ analysisHistory, analysisTrash });
    return analysisHistory;
  });
}

async function restoreHistoryFromTrash(id) {
  return queueHistoryMutation(async () => {
    const stored = await chrome.storage.local.get({ analysisHistory: [], analysisTrash: [] });
    const restoring = id ? stored.analysisTrash.filter(entry => entry.id === id) : stored.analysisTrash;
    let analysisTrash = id ? stored.analysisTrash.filter(entry => entry.id !== id) : [];
    const restored = restoring
      .map(entry => {
        const cleanEntry = { ...entry };
        delete cleanEntry.trashedAt;
        return cleanEntry;
      })
      .sort((a, b) => b.createdAt - a.createdAt);
    const restoredIds = new Set(restored.map(entry => entry.id));
    const analysisHistory = [...restored, ...stored.analysisHistory.filter(entry => !restoredIds.has(entry.id))];
    const evicted = trimCollection(analysisHistory, MAX_HISTORY_ITEMS, MAX_HISTORY_BYTES);
    analysisTrash = addToTrash(analysisTrash, evicted);
    await chrome.storage.local.set({ analysisHistory, analysisTrash });
    return { history: analysisHistory, trash: analysisTrash };
  });
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
  const calculated = 768 * Math.sqrt(3 / Math.max(1, pageCount));
  const limited = Math.max(320, Math.min(768, calculated));
  return Math.max(320, Math.floor(limited / 32) * 32);
}

async function captureVisibleTabSafely(windowId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const waitMs = Math.max(0, MIN_CAPTURE_INTERVAL_MS - (Date.now() - lastCaptureAt));
    if (waitMs) await sleep(waitMs);
    try {
      lastCaptureAt = Date.now();
      return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
    } catch (error) {
      const message = error.message || String(error);
      const isQuotaError = /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota/i.test(message);
      const hasNoActiveContents = /No active web contents to capture/i.test(message);
      if ((!isQuotaError && !hasNoActiveContents) || attempt === 4) throw error;
      await sleep((hasNoActiveContents ? 700 : 1000) * (attempt + 1));
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

async function sourceImageToPng(imageSrc, targetWidth) {
  if (!imageSrc) throw new Error("img 원본 주소가 없습니다.");
  const response = await fetch(imageSrc, { credentials: "include", cache: "force-cache" });
  if (!response.ok) throw new Error(`img 원본 요청 실패 (${response.status})`);
  const bitmap = await createImageBitmap(await response.blob());
  const width = targetWidth;
  const height = Math.max(1, Math.round(bitmap.height * width / bitmap.width));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d", { alpha: false });
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, 0, 0, width, height);
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

function tabUrl(tab) {
  return tab?.url || tab?.pendingUrl || "";
}

function isBrowserInternalPage(url) {
  return /^(?:about:|brave:|chrome:|chrome-extension:|chrome-untrusted:|devtools:|edge:|kiwi:|moz-extension:|opera:|vivaldi:)/i.test(url);
}

function assertSupportedActiveTab(tab) {
  const url = tabUrl(tab);
  if (isBrowserInternalPage(url)) {
    throw new Error("브라우저 내부 페이지에서는 분석을 실행하지 않습니다. Canva 디자인 편집 탭으로 이동한 뒤 다시 시도해 주세요.");
  }
}

async function getActiveEditorTab() {
  const queries = [
    { active: true, currentWindow: true },
    { active: true, lastFocusedWindow: true },
    { active: true }
  ];
  for (let queryIndex = 0; queryIndex < queries.length; queryIndex++) {
    const query = queries[queryIndex];
    const tabs = await chrome.tabs.query(query);
    if (queryIndex === 0 && tabs[0]) assertSupportedActiveTab(tabs[0]);
    const canvaTab = tabs.find(tab => {
      if (!tab.id) return false;
      try {
        return /(^|\.)canva\.com$/i.test(new URL(tabUrl(tab) || "https://invalid.local").hostname);
      } catch {
        return false;
      }
    });
    if (canvaTab) return canvaTab;
    const usableTab = tabs.find(tab => tab.id && !isBrowserInternalPage(tabUrl(tab)));
    if (usableTab) return usableTab;
  }
  throw new Error("활성화된 Canva 탭을 찾지 못했습니다.");
}

async function captureSlides(tab) {
  const info = await getPageInfo(tab.id);
  if (info?.error) throw new Error(info.error);
  if (!info?.count) {
    throw new Error(".JFv1rQ 요소를 찾지 못했습니다. Canva의 페이지 목록이 열린 상태에서 다시 시도해 주세요.");
  }

  const targetWidth = automaticImageWidth(info.count);
  const images = [];
  for (let index = 0; index < info.count; index++) {
    await setState({
      status: "running",
      percent: 12 + Math.round((index / info.count) * 53),
      message: `${index + 1}/${info.count} 페이지 전체 미리보기를 ${targetWidth}px PNG로 변환 중`
    });
    const exported = await sendToTab(tab.id, { type: "EXPORT_PAGE_IMAGE", index, targetWidth });
    if (exported?.error) throw new Error(exported.error);
    if (exported?.dataUrl) {
      images.push(exported.dataUrl);
      continue;
    }
    if (exported?.imageSrc) {
      try {
        images.push(await sourceImageToPng(exported.imageSrc, targetWidth));
        continue;
      } catch (sourceError) {
        console.warn(`Canva Design Score ${index + 1}페이지 원본 img 변환 실패`, sourceError);
      }
    }
    const rect = exported?.fallbackRect;
    if (!rect) throw new Error(`${index + 1}페이지의 전체 미리보기를 PNG로 변환하지 못했습니다.`);
    await chrome.runtime.sendMessage({ type: "CLOSE_POPUP_FOR_CAPTURE" }).catch(() => {});
    await sleep(500);
    await sleep(120);
    if (rect.x < -2 || rect.y < -2 || rect.x + rect.width > rect.viewportWidth + 2 || rect.y + rect.height > rect.viewportHeight + 2) {
      throw new Error(`${index + 1}페이지의 전체 미리보기가 화면에 완전히 보이지 않아 대체 캡처할 수 없습니다.`);
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
    const tab = await getActiveEditorTab();
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
    const result = { ...data, presentation_title: title };
    try {
      await saveHistory(result);
    } catch (historyError) {
      console.warn("Canva Design Score history save failed", historyError);
    }
    await setState({
      status: "done",
      percent: 100,
      message: "평가 완료",
      result
    });
  } catch (error) {
    await setState({ status: "error", percent: 0, error: error.message || String(error) });
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "PAGE_LOAD_PROGRESS") {
    setState({ status: "running", percent: message.percent, message: message.message }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.type === "GET_HISTORY") {
    chrome.storage.local.get({ analysisHistory: [] }).then(({ analysisHistory }) => sendResponse({ ok: true, history: analysisHistory }));
    return true;
  }
  if (message.type === "GET_TRASH") {
    chrome.storage.local.get({ analysisTrash: [] }).then(({ analysisTrash }) => sendResponse({ ok: true, trash: analysisTrash }));
    return true;
  }
  if (message.type === "DELETE_HISTORY") {
    moveHistoryToTrash(message.id).then(history => sendResponse({ ok: true, history })).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "DELETE_ALL_HISTORY") {
    moveHistoryToTrash(null).then(history => sendResponse({ ok: true, history })).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "RESTORE_HISTORY") {
    restoreHistoryFromTrash(message.id).then(result => sendResponse({ ok: true, ...result })).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "RESTORE_ALL_HISTORY") {
    restoreHistoryFromTrash(null).then(result => sendResponse({ ok: true, ...result })).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "START_ANALYSIS") {
    chrome.storage.local.get("analysisState").then(async ({ analysisState }) => {
      if (analysisState?.status === "running" && Date.now() - analysisState.updatedAt < 5 * 60 * 1000) {
        sendResponse({ ok: false, error: "이미 분석이 진행 중입니다." });
        return;
      }
      await setState({ status: "running", percent: 1, message: "새 분석 준비 중" });
      sendResponse({ ok: true });
      runAnalysis(message.settings);
    });
    return true;
  }
});
