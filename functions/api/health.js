export async function onRequestGet({ env }) {
  return Response.json({
    ok: true,
    service: "canva-design-score",
    openaiConfigured: Boolean(env.OPENAI_API_KEY),
    accessTokenConfigured: Boolean(env.API_ACCESS_TOKEN),
    models: ["gpt-5.6-luna", "gpt-5.6-terra"]
  }, { headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
}

