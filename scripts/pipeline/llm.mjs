// One interface, three model providers: generateJSON({ system, prompt, schema }) -> object.
// Pick with "provider" in myscroll.config.json (or MYSCROLL_PROVIDER). Keys come from env vars.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Gemini's responseSchema is an OpenAPI subset: drop keywords it doesn't accept.
function geminiSchema(s) {
  if (Array.isArray(s)) return s.map(geminiSchema);
  if (!s || typeof s !== "object") return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (["additionalProperties", "$schema", "minLength", "maxLength", "pattern"].includes(k)) continue;
    out[k] = typeof v === "object" ? geminiSchema(v) : v;
  }
  return out;
}

async function gemini({ system, prompt, schema, model }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set (create one at https://aistudio.google.com/apikey)");
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: "application/json", responseSchema: geminiSchema(schema), temperature: 0.7,
        // Summarising doesn't need much reasoning: keep thinking low to save quota and time.
        ...(model.startsWith("gemini-2.5") ? { thinkingConfig: { thinkingBudget: 0 } }
          : model.startsWith("gemini-3") ? { thinkingConfig: { thinkingLevel: "low" } } : {}),
      },
    }),
  });
  if (!res.ok) {
    const detail = (await res.text()).replace(/\s+/g, " ").slice(0, 300);
    const err = new Error(`Gemini ${model} ${res.status}: ${detail}`);
    err.retryable = res.status === 429 || res.status >= 500;
    err.tryNextModel = res.status === 404 || res.status === 429 || res.status === 503;
    throw err;
  }
  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
  if (!text) throw new Error(`Gemini returned no text (${data.candidates?.[0]?.finishReason ?? "unknown"})`);
  return { json: JSON.parse(text), usage: data.usageMetadata };
}

async function ollama({ system, prompt, schema, model, url }) {
  const res = await fetch(`${url}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model, stream: false, format: schema, options: { temperature: 0.6, num_ctx: 32768 },
      messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return { json: JSON.parse(data.message.content), usage: { prompt: data.prompt_eval_count, output: data.eval_count } };
}

async function claude({ system, prompt, schema, model }) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();
  const stream = client.messages.stream({
    model,
    max_tokens: 64000,
    system,
    messages: [{ role: "user", content: prompt }],
    output_config: { effort: "low", format: { type: "json_schema", schema } },
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === "refusal") throw new Error("Claude declined this request");
  const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return { json: JSON.parse(text), usage: msg.usage };
}

const PROVIDERS = { gemini, ollama, claude };

export async function generateJSON(config, req) {
  const provider = process.env.MYSCROLL_PROVIDER ?? config.provider;
  const fn = PROVIDERS[provider];
  if (!fn) throw new Error(`Unknown provider "${provider}" (use gemini, ollama or claude)`);
  const models = [process.env.MYSCROLL_MODEL ?? config.models[provider], ...(config.fallbackModels?.[provider] ?? [])];
  let lastError;
  for (const model of models) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await fn({ ...req, model, url: config.ollamaUrl });
      } catch (e) {
        lastError = e;
        if (e.tryNextModel && (e.message.includes(" 404") || attempt === 2)) break; // busy or gone: try the next model
        const retry = attempt < 3 && (e.retryable || e instanceof SyntaxError || /fetch failed|ECONNRESET|timeout/i.test(e.message));
        if (!retry) throw e;
        await sleep(5000 * attempt * attempt); // free tiers are rate limited: back off generously
      }
    }
  }
  throw lastError;
}
