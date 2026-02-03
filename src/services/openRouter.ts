import { performance } from "node:perf_hooks";

export type GoalValidationResult = "realistic" | "too_aggressive" | "too_easy";

export type GoalValidation = {
  result: GoalValidationResult;
  feedback: string;
  llmModel: string;
  tokensUsed?: number;
  processingTimeMs: number;
};

export type CheckinRecommendation = {
  progress_assessment: string;
  body_composition_notes: string;
  nutrition_advice: string;
  training_advice: string;
  motivational_message: string;
  warning_flags: string[];
};

export type CheckinRecommendationResponse = {
  recommendation: CheckinRecommendation;
  llmModel: string;
  tokensUsed?: number;
  processingTimeMs: number;
};

export type CheckinPhotoValidation = {
  isValid: boolean;
  invalidPhotos: Array<"front" | "left" | "right" | "back">;
  reasons: Partial<Record<"front" | "left" | "right" | "back", string>>;
  llmModel: string;
  tokensUsed?: number;
  processingTimeMs: number;
};

export type OpenRouterClient = {
  validateGoal: (input: {
    track: "cut" | "bulk";
    startWeight: number;
    startWaist: number;
    heightCm: number;
    targetWeight: number;
    targetWaist: number;
  }) => Promise<GoalValidation>;

  analyzeCheckin: (input: {
    track: "cut" | "bulk";
    goalWeight: number;
    goalWaist: number;
    startWeight: number;
    startWaist: number;
    heightCm: number;
    currentWeight: number;
    currentWaist: number;
    historyText: string;
    photosBase64Jpeg: string[]; // data:image/jpeg;base64,...
  }) => Promise<CheckinRecommendationResponse>;

  validateCheckinPhotos: (input: {
    photosBase64Jpeg: Record<"front" | "left" | "right" | "back", string>;
  }) => Promise<CheckinPhotoValidation>;
};

export function createOpenRouterClient(opts: {
  apiKey: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  model?: string;
}): OpenRouterClient {
  const fetchImpl = opts.fetch ?? fetch;
  const baseUrl = opts.baseUrl ?? "https://openrouter.ai/api/v1";
  const model = opts.model ?? "google/gemini-3-flash-preview";

  async function chatCompletions(request: unknown) {
    const started = performance.now();
    const res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(request)
    });
    const text = await res.text();
    const ms = Math.round(performance.now() - started);
    if (!res.ok) {
      throw new Error(`OpenRouter error: ${res.status} ${res.statusText} — ${text}`);
    }
    const json = JSON.parse(text) as any;
    return { json, ms };
  }

  return {
    async validateGoal(input) {
      const system = `Ты спортивный консультант. Оцени реалистичность цели для человека.
Верни строго JSON без пояснений вокруг.`;
      const user = `Данные:
- трек: ${input.track === "cut" ? "Похудеть" : "Набрать"}
- рост: ${input.heightCm} см
- старт: ${input.startWeight} кг, талия ${input.startWaist} см
- цель: ${input.targetWeight} кг, талия ${input.targetWaist} см

Классифицируй цель:
- realistic: реалистично и безопасно
- too_aggressive: слишком агрессивно/рискованно
- too_easy: слишком легко (почти нет прогресса)

Ответ JSON:
{"result":"realistic|too_aggressive|too_easy","feedback":"короткий совет на русском (1-3 предложения)"}`
        .trim();

      const { json, ms } = await chatCompletions({
        model,
        temperature: 0.2,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      });

      const content = String(json?.choices?.[0]?.message?.content ?? "");
      const parsed = safeJsonParse(content) as any;
      const result = (parsed?.result as GoalValidationResult) ?? "realistic";
      const feedback = (parsed?.feedback as string) ?? "";
      const tokensUsed = typeof json?.usage?.total_tokens === "number" ? json.usage.total_tokens : undefined;

      return { result, feedback, llmModel: model, tokensUsed, processingTimeMs: ms };
    },

    async analyzeCheckin(input) {
      const system = `Ты фитнес‑коуч. Дай рекомендации по чек‑ину на русском. Верни строго JSON без лишнего текста.`;

      const contentParts: any[] = [
        {
          type: "text",
          text: `Данные:
- трек: ${input.track === "cut" ? "Похудеть" : "Набрать"}
- рост: ${input.heightCm} см
- старт: ${input.startWeight} кг, талия ${input.startWaist} см
- цель: ${input.goalWeight} кг, талия ${input.goalWaist} см
- текущие: ${input.currentWeight} кг, талия ${input.currentWaist} см

История чек‑инов (кратко):
${input.historyText}

Ответ JSON:
{
 "progress_assessment":"...",
 "body_composition_notes":"...",
 "nutrition_advice":"...",
 "training_advice":"...",
 "motivational_message":"...",
 "warning_flags":[]
}`
        }
      ];

      for (const img of input.photosBase64Jpeg) {
        contentParts.push({ type: "image_url", image_url: { url: img } });
      }

      const { json, ms } = await chatCompletions({
        model,
        temperature: 0.4,
        messages: [{ role: "system", content: system }, { role: "user", content: contentParts }]
      });

      const content = String(json?.choices?.[0]?.message?.content ?? "");
      const parsed = safeJsonParse(content) as any;
      const recommendation: CheckinRecommendation = {
        progress_assessment: String(parsed?.progress_assessment ?? ""),
        body_composition_notes: String(parsed?.body_composition_notes ?? ""),
        nutrition_advice: String(parsed?.nutrition_advice ?? ""),
        training_advice: String(parsed?.training_advice ?? ""),
        motivational_message: String(parsed?.motivational_message ?? ""),
        warning_flags: Array.isArray(parsed?.warning_flags)
          ? parsed.warning_flags.map((x: any) => String(x))
          : []
      };
      const tokensUsed = typeof json?.usage?.total_tokens === "number" ? json.usage.total_tokens : undefined;
      return { recommendation, llmModel: model, tokensUsed, processingTimeMs: ms };
    },
    async validateCheckinPhotos(input) {
      const system =
        "Ты помощник по проверке фото чек-ина. Определи, есть ли на каждом фото человек (желательно в полный рост). Верни строго JSON без лишнего текста.";

      const contentParts: any[] = [
        {
          type: "text",
          text: `Проверь каждое фото и верни JSON:
{
 "front": {"status":"ok|no_person|bad_photo","reason":"..."},
 "left": {"status":"ok|no_person|bad_photo","reason":"..."},
 "right": {"status":"ok|no_person|bad_photo","reason":"..."},
 "back": {"status":"ok|no_person|bad_photo","reason":"..."}
}
Где:
- ok: человек виден
- no_person: человека нет
- bad_photo: слишком темно/размыто/непонятно`
        }
      ];

      contentParts.push({ type: "text", text: "Фото front (анфас):" });
      contentParts.push({ type: "image_url", image_url: { url: input.photosBase64Jpeg.front } });
      contentParts.push({ type: "text", text: "Фото left (профиль слева):" });
      contentParts.push({ type: "image_url", image_url: { url: input.photosBase64Jpeg.left } });
      contentParts.push({ type: "text", text: "Фото right (профиль справа):" });
      contentParts.push({ type: "image_url", image_url: { url: input.photosBase64Jpeg.right } });
      contentParts.push({ type: "text", text: "Фото back (со спины):" });
      contentParts.push({ type: "image_url", image_url: { url: input.photosBase64Jpeg.back } });

      const { json, ms } = await chatCompletions({
        model,
        temperature: 0.1,
        messages: [{ role: "system", content: system }, { role: "user", content: contentParts }]
      });

      const content = String(json?.choices?.[0]?.message?.content ?? "");
      const parsed = safeJsonParse(content) as any;

      const invalidPhotos: Array<"front" | "left" | "right" | "back"> = [];
      const reasons: Partial<Record<"front" | "left" | "right" | "back", string>> = {};
      const keys: Array<"front" | "left" | "right" | "back"> = ["front", "left", "right", "back"];
      for (const key of keys) {
        const status = String(parsed?.[key]?.status ?? "");
        const reason = String(parsed?.[key]?.reason ?? "");
        if (status && status !== "ok") {
          invalidPhotos.push(key);
          if (reason) reasons[key] = reason;
        }
      }
      const tokensUsed = typeof json?.usage?.total_tokens === "number" ? json.usage.total_tokens : undefined;
      return {
        isValid: invalidPhotos.length === 0,
        invalidPhotos,
        reasons,
        llmModel: model,
        tokensUsed,
        processingTimeMs: ms
      };
    }
  };
}

function safeJsonParse(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    const first = s.indexOf("{");
    const last = s.lastIndexOf("}");
    if (first !== -1 && last !== -1 && last > first) {
      try {
        return JSON.parse(s.slice(first, last + 1));
      } catch {
        return {};
      }
    }
    return {};
  }
}
