// Vercel Serverless Function: secure TreeAI image analysis with Gemini.
// The API key must stay in Vercel Environment Variables as GEMINI_API_KEY.

const MODEL = "gemini-3.8-flash";

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, Number(n) || 0));
}

function cleanArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String).slice(0, 8);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "GEMINI_API_KEY is not configured in Vercel." });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const image = body?.image;
    if (!image || typeof image !== "string") {
      return res.status(400).json({ error: "No image was provided." });
    }

    const match = image.match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,(.+)$/i);
    if (!match) {
      return res.status(400).json({ error: "Please upload a JPG, PNG, or WEBP image." });
    }

    const mimeType = match[1].toLowerCase().replace("image/jpg", "image/jpeg");
    const base64Data = match[2];
    if (base64Data.length > 8_000_000) {
      return res.status(413).json({ error: "Image is too large after compression. Please try a smaller image." });
    }

    const prompt = `You are TreeAI, a careful visual assistant for identifying trees and assessing visible tree/leaf health in Tamil Nadu, India.

Analyze the supplied image. It may show a whole tree, leaf, bark, fruit, branch, or another tree part.

Rules:
- Identify the tree species only when the visual evidence supports it. If uncertain, use "Unknown" rather than inventing a species.
- If the image is not a tree/plant image, set tree_name to "Not a tree image" and explain briefly in summary.
- Do not invent a disease. If no disease is visually supported, use "No clear disease identified".
- Confidence is your confidence in the visual identification, from 0 to 100. Do not use 94 by default.
- Severity must be exactly one of: Low, Medium, High, Unknown.
- Keep advice conservative and practical. Do not recommend dangerous chemicals or unsafe application instructions.
- Return concise UI-friendly information.
- Tamil name can be included when you are reasonably confident; otherwise say "தமிழ் பெயர் கிடைக்கவில்லை".
- The result is a visual assessment, not a laboratory diagnosis.

Return ONLY valid JSON matching the requested schema.`;

    const schema = {
      type: "object",
      properties: {
        input_type: { type: "string" },
        tree_name: { type: "string" },
        tamil_name: { type: "string" },
        scientific_name: { type: "string" },
        confidence: { type: "number" },
        disease: { type: "string" },
        severity: { type: "string", enum: ["Low", "Medium", "High", "Unknown"] },
        summary: { type: "string" },
        symptoms: { type: "array", items: { type: "string" } },
        cause: { type: "array", items: { type: "string" } },
        treatment: { type: "array", items: { type: "string" } },
        prevention: { type: "array", items: { type: "string" } }
      },
      required: [
        "input_type", "tree_name", "tamil_name", "scientific_name", "confidence",
        "disease", "severity", "summary", "symptoms", "cause", "treatment", "prevention"
      ]
    };

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const geminiResponse = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [
            { text: prompt },
            { inlineData: { mimeType, data: base64Data } }
          ]
        }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: schema,
          temperature: 0.2
        }
      })
    });

    const raw = await geminiResponse.json();
    if (!geminiResponse.ok) {
      const message = raw?.error?.message || "Gemini API request failed.";
      return res.status(502).json({ error: message });
    }

    const text = raw?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("").trim();
    if (!text) {
      return res.status(502).json({ error: "Gemini returned no analysis." });
    }

    let result;
    try {
      result = JSON.parse(text);
    } catch {
      return res.status(502).json({ error: "Gemini returned an invalid analysis format." });
    }

    result.confidence = clamp(result.confidence, 0, 100);
    result.symptoms = cleanArray(result.symptoms);
    result.cause = cleanArray(result.cause);
    result.treatment = cleanArray(result.treatment);
    result.prevention = cleanArray(result.prevention);
    if (!["Low", "Medium", "High", "Unknown"].includes(result.severity)) result.severity = "Unknown";

    return res.status(200).json(result);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Server error while analyzing the tree image." });
  }
}
