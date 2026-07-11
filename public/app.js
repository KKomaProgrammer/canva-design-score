(async () => {
  const status = document.querySelector("#status");
  const dot = document.querySelector("#dot");
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "API unavailable");
    dot.classList.add("ok");
    status.textContent = data.openaiConfigured ? "API 정상 · OpenAI 키 설정됨" : "API 정상 · OpenAI 키 설정 필요";
  } catch (error) {
    dot.classList.add("bad");
    status.textContent = `API 확인 실패 · ${error.message}`;
  }
})();

