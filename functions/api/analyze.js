const MAX_BODY_BYTES = 24 * 1024 * 1024;
const MAX_SLIDES = 30;
const MODELS = new Set(["gpt-5.6-luna", "gpt-5.6-terra"]);

const rubric = {
  hierarchy_readability: 20,
  layout_alignment: 20,
  color_contrast: 15,
  typography: 15,
  visual_consistency: 15,
  content_density_clarity: 10,
  polish_originality: 5
};

const slideSchema = {
  type: "object",
  additionalProperties: false,
  required: ["page", "score", "grade", "criteria", "strengths", "issues", "priority_fixes"],
  properties: {
    page: { type: "integer", minimum: 1 },
    score: { type: "number", minimum: 0, maximum: 100 },
    grade: { type: "string", enum: ["S", "A", "B", "C", "D", "F"] },
    criteria: {
      type: "object",
      additionalProperties: false,
      required: Object.keys(rubric),
      properties: Object.fromEntries(Object.entries(rubric).map(([key, max]) => [key, { type: "number", minimum: 0, maximum: max }]))
    },
    strengths: { type: "array", minItems: 1, maxItems: 4, items: { type: "string" } },
    issues: { type: "array", minItems: 1, maxItems: 5, items: { type: "string" } },
    priority_fixes: { type: "array", minItems: 1, maxItems: 4, items: { type: "string" } }
  }
};

const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["deck_score", "deck_grade", "summary", "consistency_review", "top_actions", "slides"],
  properties: {
    deck_score: { type: "number", minimum: 0, maximum: 100 },
    deck_grade: { type: "string", enum: ["S", "A", "B", "C", "D", "F"] },
    summary: { type: "string" },
    consistency_review: { type: "string" },
    top_actions: { type: "array", minItems: 2, maxItems: 6, items: { type: "string" } },
    slides: { type: "array", minItems: 1, maxItems: MAX_SLIDES, items: slideSchema }
  }
};

function cors(origin, env) {
  const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map(value => value.trim()).filter(Boolean);
  const allowOrigin = !allowed.length || !origin || allowed.includes(origin) ? (origin || "*") : "null";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "Content-Type, X-Access-Token",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
    "Cache-Control": "no-store"
  };
}

function json(data, status, headers) {
  return Response.json(data, { status, headers });
}

function readOutputText(data) {
  if (typeof data.output_text === "string" && data.output_text) return data.output_text;
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if ((content.type === "output_text" || content.type === "text") && typeof content.text === "string") return content.text;
    }
  }
  return "";
}

export async function onRequestOptions({ request, env }) {
  return new Response(null, { status: 204, headers: cors(request.headers.get("Origin"), env) });
}

export async function onRequestPost({ request, env }) {
  const headers = cors(request.headers.get("Origin"), env);
  try {
    if (!env.OPENAI_API_KEY) return json({ error: "서버에 OPENAI_API_KEY가 설정되지 않았습니다." }, 503, headers);
    if (env.API_ACCESS_TOKEN && request.headers.get("X-Access-Token") !== env.API_ACCESS_TOKEN) {
      return json({ error: "Access Token이 올바르지 않습니다." }, 401, headers);
    }
    const declaredLength = Number(request.headers.get("Content-Length") || 0);
    if (declaredLength > MAX_BODY_BYTES) return json({ error: "요청 이미지 용량이 너무 큽니다." }, 413, headers);
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return json({ error: "요청 이미지 용량이 너무 큽니다." }, 413, headers);
    const body = JSON.parse(raw);
    const model = MODELS.has(body.model) ? body.model : "gpt-5.6-luna";
    const images = Array.isArray(body.images) ? body.images : [];
    if (!images.length || images.length > MAX_SLIDES) return json({ error: `슬라이드는 1~${MAX_SLIDES}장이어야 합니다.` }, 400, headers);
    if (images.some(image => typeof image !== "string" || !image.startsWith("data:image/png;base64,"))) {
      return json({ error: "PNG data URL만 전송할 수 있습니다." }, 400, headers);
    }

    const prompt = [
      `첨부된 ${images.length}장은 하나의 Canva 프레젠테이션이며 입력 순서가 페이지 순서다.`,
      "당신은 까다롭고 일관된 프레젠테이션 아트 디렉터다. 내용의 사실성보다 보이는 디자인 완성도를 평가한다.",
      "각 페이지를 100점으로 채점하라. 배점은 시각적 위계·가독성 20, 레이아웃·정렬·여백 20, 색상·대비 15, 타이포그래피 15, 페이지 간 시각 일관성 15, 정보 밀도·명료성 10, 마감·독창성 5다.",
      "점수 인플레이션을 피한다. 90점 이상은 실제 공개·발표에 바로 써도 될 정도로 예외적으로 완성된 경우에만 준다. 80점은 강한 결과물, 70점은 양호하지만 수정 필요, 60점은 평균적, 50점 이하는 명백한 문제로 해석한다.",
      "모호한 칭찬을 피하고 화면에서 확인되는 근거를 쓴다. 수정 제안은 위치·크기·간격·색·서체·정렬처럼 실행 가능하게 쓴다. 작은 글자가 완전히 판독되지 않으면 추측하지 말고 가독성/밀도 관점만 평가한다.",
      "deck_score는 페이지 평균과 페이지 간 일관성을 함께 반영한다. 모든 응답은 한국어로 작성한다."
    ].join("\n");

    const content = [{ type: "input_text", text: prompt }];
    images.forEach((image, index) => {
      content.push({ type: "input_text", text: `페이지 ${index + 1}` });
      content.push({ type: "input_image", image_url: image, detail: "high" });
    });

    const openaiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Authorization": `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        reasoning: { effort: "medium" },
        max_output_tokens: 12000,
        input: [{ role: "user", content }],
        text: { format: { type: "json_schema", name: "canva_design_evaluation", strict: true, schema: outputSchema } }
      })
    });
    const data = await openaiResponse.json();
    if (!openaiResponse.ok) {
      const message = data?.error?.message || "OpenAI API 요청에 실패했습니다.";
      return json({ error: message, code: data?.error?.code || "openai_error" }, openaiResponse.status, headers);
    }
    const text = readOutputText(data);
    if (!text) return json({ error: "모델 응답에서 결과 텍스트를 찾지 못했습니다." }, 502, headers);
    let result;
    try { result = JSON.parse(text); } catch { return json({ error: "모델이 올바른 JSON을 반환하지 않았습니다.", raw: text.slice(0, 800) }, 502, headers); }
    return json({ ...result, model, usage: data.usage || null }, 200, headers);
  } catch (error) {
    const status = error instanceof SyntaxError ? 400 : 500;
    return json({ error: status === 400 ? "요청 JSON이 올바르지 않습니다." : `서버 오류: ${error.message}` }, status, headers);
  }
}

