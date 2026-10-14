const DEFAULT_GROQ_MODEL = "openai/gpt-oss-20b";
const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";
const MAX_BODY_BYTES = 32 * 1024;

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowedOrigins = (env.ALLOWED_ORIGINS || "https://jeehjung.github.io,http://localhost:5173,http://127.0.0.1:5500")
      .split(",").map((value) => value.trim()).filter(Boolean);
    const corsOrigin = allowedOrigins.includes(origin) ? origin : "";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(corsOrigin) });
    }
    if (request.method !== "POST") return json({ error: "Use POST with a JSON body." }, 405, corsOrigin);
    if (origin && !corsOrigin) return json({ error: "Origin not allowed." }, 403, "");

    const contentLength = Number(request.headers.get("Content-Length") || 0);
    if (contentLength > MAX_BODY_BYTES) return json({ error: "Request body too large." }, 413, corsOrigin);

    let body;
    try { body = await request.json(); }
    catch { return json({ error: "Invalid JSON body." }, 400, corsOrigin); }

    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return json({ error: "Provide a non-empty messages array." }, 400, corsOrigin);
    }
    if (JSON.stringify(body).length > MAX_BODY_BYTES) return json({ error: "Request body too large." }, 413, corsOrigin);
    if (!env.GROQ_API_KEY) return json({ error: "Server is missing GROQ_API_KEY secret." }, 500, corsOrigin);

    const groqModel = env.GROQ_MODEL || DEFAULT_GROQ_MODEL;
    const geminiModel = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
    const primary = await callGroq(env.GROQ_API_KEY, groqModel, body);
    if (primary.ok) return json({ ...primary.data, provider: "groq", model: groqModel }, 200, corsOrigin);

    // Fallback only for rate limits and transient upstream failures.
    if (![408, 429, 500, 502, 503, 504].includes(primary.status)) {
      return json({
        error: "Groq request failed.",
        provider: "groq",
        upstreamStatus: primary.status,
        details: primary.message,
      }, primary.status >= 400 && primary.status < 500 ? primary.status : 502, corsOrigin);
    }
    if (!env.GEMINI_API_KEY) {
      return json({
        error: "Groq is rate-limited or temporarily unavailable, but GEMINI_API_KEY is not configured.",
        provider: "groq",
        upstreamStatus: primary.status,
      }, 503, corsOrigin);
    }

    const fallback = await callGemini(env.GEMINI_API_KEY, geminiModel, body);
    if (!fallback.ok) {
      return json({
        error: "Both Groq and Gemini requests failed.",
        fallbackProvider: "gemini",
        upstreamStatus: fallback.status,
        details: fallback.message,
      }, 502, corsOrigin);
    }
    return json({
      ...fallback.data,
      provider: "gemini",
      model: geminiModel,
      fallback: true,
      fallbackReason: "groq_rate_limit_or_temporary_error",
    }, 200, corsOrigin);
  },
};

async function callGroq(apiKey, model, body) {
  let response;
  try {
    response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: body.messages,
        temperature: typeof body.temperature === "number" ? body.temperature : 0.3,
        max_tokens: Math.min(Number(body.max_tokens) || 1024, 4096),
        stream: false,
      }),
    });
  } catch (error) { return { ok: false, status: 503, message: String(error) }; }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) return {
    ok: false, status: response.status,
    message: data?.error?.message || data?.message || "Groq upstream error",
  };
  return { ok: true, data };
}

async function callGemini(apiKey, model, body) {
  const systems = body.messages.filter((message) => message.role === "system");
  const contents = body.messages.filter((message) => message.role !== "system").map((message) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: String(message.content ?? "") }],
  }));
  const payload = {
    contents,
    generationConfig: {
      temperature: typeof body.temperature === "number" ? body.temperature : 0.3,
      maxOutputTokens: Math.min(Number(body.max_tokens) || 1024, 4096),
    },
  };
  if (systems.length) payload.systemInstruction = {
    parts: [{ text: systems.map((message) => String(message.content ?? "")).join("\n\n") }],
  };

  let response;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
    );
  } catch (error) { return { ok: false, status: 503, message: String(error) }; }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) return {
    ok: false, status: response.status,
    message: data?.error?.message || "Gemini upstream error",
  };

  const text = (data.candidates?.[0]?.content?.parts || []).map((part) => part.text || "").join("");
  return {
    ok: true,
    data: {
      id: data.responseId || `gemini-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: data.candidates?.[0]?.finishReason || "stop",
      }],
      usage: data.usageMetadata ? {
        prompt_tokens: data.usageMetadata.promptTokenCount,
        completion_tokens: data.usageMetadata.candidatesTokenCount,
        total_tokens: data.usageMetadata.totalTokenCount,
      } : undefined,
    },
  };
}

function corsHeaders(origin) {
  const headers = new Headers({
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  if (origin) headers.set("Access-Control-Allow-Origin", origin);
  return headers;
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders(origin) });
}
