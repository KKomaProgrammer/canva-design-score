const $ = selector => document.querySelector(selector);
const DEFAULT_ENDPOINT = "https://canva-design-score.pages.dev/api/analyze";
let pollTimer;
let currentResult = null;
let historyEntries = [];
let historyMode = "history";

async function loadSettings() {
  const saved = await chrome.storage.sync.get({ endpoint: DEFAULT_ENDPOINT, token: "", model: "gpt-5.6-luna" });
  $("#endpoint").value = saved.endpoint;
  $("#token").value = saved.token;
  $("#model").value = saved.model;
}

async function saveSettings() {
  const endpoint = $("#endpoint").value.trim().replace(/\/$/, "");
  if (!/^https:\/\//.test(endpoint)) throw new Error("API 주소는 https://로 시작해야 합니다.");
  const settings = { endpoint, token: $("#token").value.trim(), model: $("#model").value };
  await chrome.storage.sync.set(settings);
  return settings;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function list(items) { return `<ul>${(items || []).map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`; }

function svgList(items) {
  return `<ul>${(items || []).map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function buildInteractiveSvg(data, title) {
  const slides = data.slides || [];
  const height = Math.max(760, 650 + slides.length * 58);
  const improvements = data.quick_improvements || data.top_actions?.slice(0, 3) || [];
  const slideSections = slides.map(slide => `<details class="slide"><summary><span>${slide.page}페이지</span><b>${Math.round(slide.score)}점 · ${escapeHtml(slide.grade)}</b></summary><div class="detail-grid"><section><h3>문제</h3>${svgList(slide.issues)}</section><section><h3>우선 수정</h3>${svgList(slide.priority_fixes)}</section><section><h3>강점</h3>${svgList(slide.strengths)}</section></div></details>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="900" height="${height}" viewBox="0 0 900 ${height}">
  <foreignObject x="0" y="0" width="900" height="${height}">
    <div xmlns="http://www.w3.org/1999/xhtml" class="report" onclick="setTimeout(function(){var report=document.querySelector('.report');var root=document.documentElement;var frame=document.querySelector('foreignObject');var next=Math.max(${height},report.scrollHeight+20);root.setAttribute('height',next);root.setAttribute('viewBox','0 0 900 '+next);frame.setAttribute('height',next)},0)">
      <style>
        *{box-sizing:border-box}body{margin:0}.report{min-height:${height}px;padding:46px;background:#f7f7fb;color:#1d1e27;font-family:Arial,'Noto Sans KR',sans-serif}.title-kicker{margin:0 0 8px;color:#7652dd;font-size:12px;font-weight:800;letter-spacing:.13em}.title{margin:0 0 26px;font-size:31px;line-height:1.25;letter-spacing:-.03em}.score{display:flex;align-items:center;justify-content:space-between;padding:24px 28px;border-radius:20px;background:#191b25;color:#fff}.score small{display:block;margin-bottom:7px;color:#b9becc;font-size:12px}.score strong{font-size:54px;letter-spacing:-.06em}.score .model{color:#b9becc;font-size:12px}.review{margin:14px 0;padding:16px 18px;border-radius:14px;background:#ece6ff;color:#38266f;font-size:15px;font-weight:700;line-height:1.6}.fixes{padding:17px 20px;border:1px solid #e1e2e9;border-radius:14px;background:#fff}.fixes h2{margin:0 0 9px;font-size:15px}.fixes ul,.detail-grid ul,.full ul{margin:7px 0 0;padding-left:20px;line-height:1.55}.toolbar{display:flex;gap:8px;margin:16px 0 10px}.toolbar button{padding:9px 13px;border:0;border-radius:9px;background:#ded5ff;color:#3b267e;font-weight:700;cursor:pointer}.toolbar button:hover{background:#cfc1ff}details{margin-top:9px;border:1px solid #dfe0e7;border-radius:12px;background:#fff;overflow:hidden}summary{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;font-size:13px;font-weight:700;cursor:pointer;user-select:none}summary:hover{background:#f3f0ff}.full summary{justify-content:flex-start;color:#49318f}.full .body{padding:0 17px 16px;color:#555a68;font-size:13px;line-height:1.6}.detail-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;padding:0 14px 15px}.detail-grid section{padding:12px;border-radius:10px;background:#f7f7fa}.detail-grid h3{margin:0;color:#4b337f;font-size:12px}.detail-grid ul{font-size:11px;color:#555a68}.footer{margin-top:22px;color:#9296a3;font-size:10px;text-align:right}
      </style>
      <p class="title-kicker">CANVA DESIGN SCORE</p>
      <h1 class="title">${escapeHtml(title)}</h1>
      <div class="score"><div><small>DECK SCORE · ${escapeHtml(data.deck_grade)}</small><strong>${Math.round(data.deck_score)}</strong></div><span class="model">${escapeHtml(data.model || "")}</span></div>
      <p class="review">${escapeHtml(data.short_review || data.summary)}</p>
      <section class="fixes"><h2>간결한 개선점</h2>${svgList(improvements)}</section>
      <div class="toolbar"><button type="button" onclick="document.querySelectorAll('details').forEach(function(item){item.open=true})">모두 펼치기</button><button type="button" onclick="document.querySelectorAll('details').forEach(function(item){item.open=false})">모두 접기</button></div>
      <details class="full"><summary>상세 전체 평가</summary><div class="body"><p>${escapeHtml(data.summary)}</p><h3>가장 먼저 고칠 것</h3>${svgList(data.top_actions)}</div></details>
      ${slideSections}
      <p class="footer">브라우저에서 항목을 눌러 상세 평가를 펼치거나 접을 수 있습니다.</p>
    </div>
  </foreignObject>
</svg>`;
}

async function currentPresentationTitle() {
  if (currentResult?.presentation_title) return currentResult.presentation_title;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const response = await chrome.tabs.sendMessage(tab.id, { type: "GET_PRESENTATION_TITLE" });
    if (response?.title) return response.title;
  } catch {}
  return "Canva 디자인 평가 결과";
}

async function downloadSvg() {
  if (!currentResult) throw new Error("먼저 프레젠테이션 평가를 실행해 주세요.");
  const title = await currentPresentationTitle();
  const svg = buildInteractiveSvg(currentResult, title);
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const safeTitle = title.replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 80) || "Canva 디자인 평가 결과";
  try {
    await chrome.downloads.download({ url, filename: `${safeTitle}-디자인평가.svg`, saveAs: true });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

function historyDeleteIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></svg>`;
}

function historyRestoreIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8v5h5M5.5 13a7 7 0 1 0 1.4-6.1L4 9"/></svg>`;
}

function trashIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></svg>`;
}

function backIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6M9 12h10"/></svg>`;
}

function updateHistoryModeUi() {
  const trashMode = historyMode === "trash";
  $("#historyTitle").textContent = trashMode ? "휴지통" : "분석 기록";
  $("#historySubtitle").textContent = trashMode ? "삭제된 기록 · 복구 가능" : "저장된 프레젠테이션";
  $("#deleteAllHistory").textContent = trashMode ? "모두 복구" : "모두 삭제";
  $("#deleteAllHistory").classList.toggle("restore-mode", trashMode);
  $("#trashButton").innerHTML = trashMode ? backIcon() : trashIcon();
  $("#trashButton").title = trashMode ? "분석 기록으로 돌아가기" : "휴지통";
  $("#trashButton").setAttribute("aria-label", $("#trashButton").title);
}

function renderHistoryList() {
  const listTarget = $("#historyList");
  if (!historyEntries.length) {
    listTarget.innerHTML = `<div class="history-empty">${historyMode === "trash" ? "휴지통이 비어 있습니다." : "저장된 분석 기록이 없습니다."}</div>`;
    return;
  }
  listTarget.innerHTML = historyEntries.map(entry => {
    const action = historyMode === "trash"
      ? `<button class="history-restore" data-restore-id="${escapeHtml(entry.id)}" title="기록 복구" aria-label="기록 복구">${historyRestoreIcon()}</button>`
      : `<button class="history-delete" data-delete-id="${escapeHtml(entry.id)}" title="기록 삭제" aria-label="기록 삭제">${historyDeleteIcon()}</button>`;
    return `<article class="history-card" data-history-id="${escapeHtml(entry.id)}" tabindex="0"><div class="history-name" title="${escapeHtml(entry.title)}">${escapeHtml(entry.title)}</div><div class="history-score">${Math.round(entry.score)}점 · ${escapeHtml(entry.grade)}</div>${action}</article>`;
  }).join("");
}

async function loadHistory() {
  updateHistoryModeUi();
  const response = await chrome.runtime.sendMessage({ type: historyMode === "trash" ? "GET_TRASH" : "GET_HISTORY" });
  if (!response?.ok) throw new Error(response?.error || "분석 기록을 불러오지 못했습니다.");
  historyEntries = historyMode === "trash" ? (response.trash || []) : (response.history || []);
  renderHistoryList();
}

async function openHistory() {
  historyMode = "history";
  $("#historyOverlay").classList.add("open");
  $("#historyOverlay").setAttribute("aria-hidden", "false");
  await loadHistory();
}

function closeHistory() {
  $("#historyOverlay").classList.remove("open");
  $("#historyOverlay").setAttribute("aria-hidden", "true");
}

async function deleteHistory(id) {
  const response = await chrome.runtime.sendMessage({ type: "DELETE_HISTORY", id });
  if (!response?.ok) throw new Error(response?.error || "기록을 삭제하지 못했습니다.");
  historyEntries = response.history || [];
  renderHistoryList();
}

async function deleteAllHistory() {
  if (!historyEntries.length || !confirm("모든 분석 기록을 휴지통으로 이동할까요?")) return;
  const response = await chrome.runtime.sendMessage({ type: "DELETE_ALL_HISTORY" });
  if (!response?.ok) throw new Error(response?.error || "기록을 삭제하지 못했습니다.");
  historyEntries = [];
  renderHistoryList();
}

async function restoreHistory(id) {
  const response = await chrome.runtime.sendMessage({ type: "RESTORE_HISTORY", id });
  if (!response?.ok) throw new Error(response?.error || "기록을 복구하지 못했습니다.");
  historyEntries = response.trash || [];
  renderHistoryList();
}

async function restoreAllHistory() {
  if (!historyEntries.length) return;
  const response = await chrome.runtime.sendMessage({ type: "RESTORE_ALL_HISTORY" });
  if (!response?.ok) throw new Error(response?.error || "기록을 복구하지 못했습니다.");
  historyEntries = response.trash || [];
  renderHistoryList();
}

async function runHistoryBulkAction() {
  if (historyMode === "trash") return restoreAllHistory();
  return deleteAllHistory();
}

function renderResult(data) {
  currentResult = data;
  const target = $("#result");
  target.innerHTML = `<div class="score"><div><span>DECK SCORE · ${escapeHtml(data.deck_grade)}</span><br><strong>${Math.round(data.deck_score)}</strong></div><span>${escapeHtml(data.model || "")}</span></div><p class="short-review">${escapeHtml(data.short_review || data.summary)}</p><div class="quick-fixes"><b>간결한 개선점</b>${list(data.quick_improvements || data.top_actions?.slice(0, 3) || [])}</div><details class="full-review"><summary>상세 전체 평가 보기</summary><p class="summary">${escapeHtml(data.summary)}</p><h3>가장 먼저 고칠 것</h3><ol class="actions">${(data.top_actions || []).map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ol></details>${(data.slides || []).map(slide => `<details class="slide"><summary>${slide.page}페이지 · ${Math.round(slide.score)}점 · ${escapeHtml(slide.grade)}</summary><div><b>문제</b>${list(slide.issues)}<b>우선 수정</b>${list(slide.priority_fixes)}<b>강점</b>${list(slide.strengths)}</div></details>`).join("")}`;
  target.classList.remove("hidden");
  $("#export").classList.remove("hidden");
}

function renderState(state) {
  const running = state?.status === "running";
  $("#analyze").disabled = running;
  $("#progress").classList.toggle("hidden", !running);
  if (running) {
    $("#progress i").style.width = `${Math.max(3, Math.min(100, state.percent || 3))}%`;
    $("#progress p").textContent = state.message || "분석 중";
  }
  if (state?.status === "done" && state.result) renderResult(state.result);
  if (state?.status === "error") {
    $("#error").textContent = state.error || "분석 중 오류가 발생했습니다.";
    $("#error").classList.remove("hidden");
  }
}

async function poll() {
  const { analysisState } = await chrome.storage.local.get("analysisState");
  renderState(analysisState);
  if (analysisState?.status === "running") pollTimer = setTimeout(poll, 450);
}

$("#save").addEventListener("click", async () => {
  try { await saveSettings(); $("#save").textContent = "저장됨"; setTimeout(() => $("#save").textContent = "설정 저장", 900); }
  catch (error) { $("#error").textContent = error.message; $("#error").classList.remove("hidden"); }
});

$("#analyze").addEventListener("click", async () => {
  try {
    clearTimeout(pollTimer);
    $("#error").classList.add("hidden");
    $("#analyze").disabled = true;
    $("#progress").classList.remove("hidden");
    $("#progress i").style.width = "3%";
    $("#progress p").textContent = "새 분석 준비 중";
    const settings = await saveSettings();
    const response = await chrome.runtime.sendMessage({ type: "START_ANALYSIS", settings });
    if (!response?.ok) throw new Error(response?.error || "분석을 시작할 수 없습니다.");
    poll();
  } catch (error) {
    $("#analyze").disabled = false;
    $("#progress").classList.add("hidden");
    $("#error").textContent = error.message;
    $("#error").classList.remove("hidden");
  }
});

$("#historyButton").addEventListener("click", () => {
  openHistory().catch(error => {
    $("#error").textContent = error.message;
    $("#error").classList.remove("hidden");
  });
});

$("#closeHistory").addEventListener("click", closeHistory);
$("#historyOverlay").addEventListener("click", event => {
  if (event.target === $("#historyOverlay")) closeHistory();
});

$("#historyList").addEventListener("click", event => {
  const restoreButton = event.target.closest("[data-restore-id]");
  if (restoreButton) {
    restoreHistory(restoreButton.dataset.restoreId).catch(error => {
      $("#error").textContent = error.message;
      $("#error").classList.remove("hidden");
    });
    return;
  }
  const deleteButton = event.target.closest("[data-delete-id]");
  if (deleteButton) {
    deleteHistory(deleteButton.dataset.deleteId).catch(error => {
      $("#error").textContent = error.message;
      $("#error").classList.remove("hidden");
    });
    return;
  }
  const card = event.target.closest("[data-history-id]");
  if (!card) return;
  const entry = historyEntries.find(item => item.id === card.dataset.historyId);
  if (!entry?.result) return;
  renderResult(entry.result);
  closeHistory();
  document.body.scrollTo({ top: $("#result").offsetTop - 8, behavior: "smooth" });
});

$("#deleteAllHistory").addEventListener("click", () => {
  runHistoryBulkAction().catch(error => {
    $("#error").textContent = error.message;
    $("#error").classList.remove("hidden");
  });
});

$("#trashButton").addEventListener("click", () => {
  historyMode = historyMode === "trash" ? "history" : "trash";
  loadHistory().catch(error => {
    $("#error").textContent = error.message;
    $("#error").classList.remove("hidden");
  });
});

$("#export").addEventListener("click", async () => {
  try {
    await downloadSvg();
  } catch (error) {
    $("#error").textContent = error.message;
    $("#error").classList.remove("hidden");
  }
});

loadSettings().then(poll);
