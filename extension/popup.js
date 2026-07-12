const $ = selector => document.querySelector(selector);
const DEFAULT_ENDPOINT = "https://canva-design-score.pages.dev/api/analyze";
let pollTimer;

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

function renderResult(data) {
  const target = $("#result");
  target.innerHTML = `<div class="score"><div><span>DECK SCORE · ${escapeHtml(data.deck_grade)}</span><br><strong>${Math.round(data.deck_score)}</strong></div><span>${escapeHtml(data.model || "")}</span></div><p class="short-review">${escapeHtml(data.short_review || data.summary)}</p><div class="quick-fixes"><b>간결한 개선점</b>${list(data.quick_improvements || data.top_actions?.slice(0, 3) || [])}</div><details class="full-review"><summary>상세 전체 평가 보기</summary><p class="summary">${escapeHtml(data.summary)}</p><h3>가장 먼저 고칠 것</h3><ol class="actions">${(data.top_actions || []).map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ol></details>${(data.slides || []).map(slide => `<details class="slide"><summary>${slide.page}페이지 · ${Math.round(slide.score)}점 · ${escapeHtml(slide.grade)}</summary><div><b>문제</b>${list(slide.issues)}<b>우선 수정</b>${list(slide.priority_fixes)}<b>강점</b>${list(slide.strengths)}</div></details>`).join("")}`;
  target.classList.remove("hidden");
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
    $("#result").classList.add("hidden");
    const settings = await saveSettings();
    const response = await chrome.runtime.sendMessage({ type: "START_ANALYSIS", settings });
    if (!response?.ok) throw new Error(response?.error || "분석을 시작할 수 없습니다.");
    poll();
  } catch (error) {
    $("#error").textContent = error.message;
    $("#error").classList.remove("hidden");
  }
});

loadSettings().then(poll);
