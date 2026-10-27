// Supabase Edge Function: analyze-food
// Required secret: GEMINI_API_KEY
// Deploy with: supabase functions deploy analyze-food
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://andreesulistya.github.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405);

  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) {
    return jsonResponse({ error: "Gemini belum dikonfigurasi. Admin perlu menambahkan secret GEMINI_API_KEY di Supabase." }, 503);
  }

  try {
    const body = await req.json();
    const imageBase64 = body?.imageBase64;
    const mimeType = body?.mimeType;

    if (typeof imageBase64 !== "string" || imageBase64.length < 100) {
      return jsonResponse({ error: "Foto tidak valid. Coba ambil foto lagi." }, 400);
    }
    if (imageBase64.length > 11_200_000) {
      return jsonResponse({ error: "Ukuran foto terlalu besar. Gunakan gambar di bawah 8 MB." }, 413);
    }
    if (!["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"].includes(mimeType)) {
      return jsonResponse({ error: "Format foto belum didukung. Coba JPG, PNG, atau WebP." }, 415);
    }

    const prompt = `Analisis foto makanan ini untuk aplikasi pencatatan kalori pribadi berbahasa Indonesia.
Identifikasi makanan yang terlihat dan perkirakan porsi yang masuk akal dari gambar. Berikan estimasi kalori total untuk makanan yang tampak, bukan kebutuhan kalori harian.
Jangan mengklaim presisi tinggi: foto tidak selalu menunjukkan berat, minyak, bahan tersembunyi, atau ukuran sebenarnya. Jika makanan/porsi sulit dikenali, nyatakan ketidakpastian dalam note dan gunakan estimasi konservatif.
Balas HANYA JSON valid dengan struktur:
{"foodName":"nama makanan ringkas dalam bahasa Indonesia","calories":number,"portion":"perkiraan porsi singkat","note":"catatan ketidakpastian singkat"}
Kalori harus bilangan bulat non-negatif. Jangan menambahkan Markdown atau teks di luar JSON.`;

    const geminiResponse = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + encodeURIComponent(apiKey),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            role: "user",
            parts: [
              { text: prompt },
              { inline_data: { mime_type: mimeType, data: imageBase64 } },
            ],
          }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: {
              type: "OBJECT",
              properties: {
                foodName: { type: "STRING" },
                calories: { type: "INTEGER" },
                portion: { type: "STRING" },
                note: { type: "STRING" },
              },
              required: ["foodName", "calories", "portion", "note"],
            },
          },
        }),
      },
    );

    const payload = await geminiResponse.json().catch(() => ({}));
    if (!geminiResponse.ok) {
      console.error("Gemini API error", geminiResponse.status, payload?.error?.message);
      if (geminiResponse.status === 429) {
        return jsonResponse({ error: "Kuota gratis Gemini sedang habis atau terkena batas permintaan. Coba lagi nanti." }, 429);
      }
      return jsonResponse({ error: "Gemini gagal menganalisis foto. Coba foto yang lebih jelas atau coba lagi nanti." }, 502);
    }

    const text = payload?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text || "").join("");
    if (!text) return jsonResponse({ error: "AI tidak mengembalikan hasil. Coba foto lagi." }, 502);

    let result;
    try { result = JSON.parse(text); } catch { return jsonResponse({ error: "Hasil AI tidak terbaca. Coba lagi." }, 502); }
    const foodName = typeof result.foodName === "string" ? result.foodName.trim().slice(0, 100) : "";
    const calories = Number(result.calories);
    if (!foodName || !Number.isFinite(calories) || calories < 0 || calories > 10000) {
      return jsonResponse({ error: "Hasil estimasi tidak valid. Coba foto yang lebih jelas." }, 502);
    }

    return jsonResponse({
      foodName,
      calories: Math.round(calories),
      portion: typeof result.portion === "string" ? result.portion.slice(0, 160) : "",
      note: typeof result.note === "string" ? result.note.slice(0, 240) : "Kalori merupakan estimasi dari foto.",
    });
  } catch (error) {
    console.error("analyze-food failed", error);
    return jsonResponse({ error: "Permintaan gagal diproses. Periksa koneksi lalu coba lagi." }, 500);
  }
});
