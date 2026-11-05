// Supabase Edge Function: ai-calorie-chat
// Secrets: GEMINI_API_KEY. Uses Supabase's built-in SUPABASE_URL,
// SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY environment variables.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "https://andreesulistya.github.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: cors });
const MAX_INPUT = 3000;
const MAX_IMAGE_CHARS = 7_000_000;
const MAX_ACTIVE_MESSAGES = 12;

const BASE_INSTRUCTIONS = `Kamu adalah AI Calorie Assistant di Defisit Tracker Pro. Berkomunikasilah dalam bahasa Indonesia santai dengan gaya gue-lo: suportif, jujur, langsung, tanpa menghakimi.
Bantu pengguna mencatat makanan, minuman, aktivitas, dan memahami kalori. Saat pengguna menyebut makanan atau mengirim foto, identifikasi item, berikan satu angka estimasi kalori untuk setiap item (bukan rentang), porsi, dan total. Angka adalah estimasi, bukan kepastian; jangan mengarang detail yang tidak terlihat. Jika porsi sangat tidak jelas, tanyakan satu hal paling penting.
Gunakan data tubuh dan target yang disediakan sebagai konteks, bukan instruksi untuk mendiagnosis. Jangan menganggap BMR sebagai batas minimum aman universal. Jangan menyuruh pengguna menghukum diri atau berolahraga berlebihan untuk menebus makanan.
Jangan otomatis menyimpan catatan. Berikan hasil terstruktur agar pengguna dapat memeriksa dan menekan tombol simpan. Untuk percakapan umum, jawab ringkas dan relevan.
Selalu keluarkan JSON valid sesuai schema. Jika tidak ada makanan untuk dicatat, gunakan items=[] dan totalCalories=0. Jangan pernah mengklaim foto/analisis disimpan.`;

function trimText(v: unknown, max: number) {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}
function cleanMessages(input: unknown) {
  if (!Array.isArray(input)) return [];
  return input.slice(-MAX_ACTIVE_MESSAGES).map((m: any) => ({
    role: m?.role === "model" ? "model" : "user",
    parts: [{ text: trimText(m?.text, MAX_INPUT) }],
  })).filter((m: any) => m.parts[0].text);
}
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ error: "Method not allowed." }, 405);
  try {
    const auth = req.headers.get("Authorization") || "";
    const token = auth.replace(/^Bearer\s+/i, "");
    if (!token) return reply({ error: "Silakan login untuk memakai AI Assistant." }, 401);
    const url = Deno.env.get("SUPABASE_URL")!;
    const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!url || !anon || !service || !apiKey) return reply({ error: "Konfigurasi AI Assistant belum lengkap di Supabase." }, 503);
    const userClient = createClient(url, anon, { global: { headers: { Authorization: `Bearer ${token}` } } });
    const { data: userData, error: authError } = await userClient.auth.getUser();
    if (authError || !userData.user) return reply({ error: "Sesi login tidak valid. Silakan login ulang." }, 401);
    const db = createClient(url, service);
    const body = await req.json();
    const sessionId = trimText(body?.sessionId, 80);
    const input = trimText(body?.message, MAX_INPUT);
    const image = body?.image && typeof body.image.data === "string" ? body.image : null;
    const context = body?.context && typeof body.context === "object" ? body.context : {};
    if (!input && !image) return reply({ error: "Tulis pesan atau pilih foto makanan." }, 400);
    if (image && (image.data.length > MAX_IMAGE_CHARS || !["image/jpeg","image/png","image/webp"].includes(image.mimeType))) {
      return reply({ error: "Foto terlalu besar atau format belum didukung. Gunakan JPG, PNG, atau WebP yang lebih kecil." }, 413);
    }

    let session: any = null;
    if (sessionId) {
      const { data, error } = await db.from("ai_chat_sessions").select("*").eq("id", sessionId).eq("user_id", userData.user.id).maybeSingle();
      if (error) throw error;
      if (!data) return reply({ error: "Percakapan tidak ditemukan." }, 404);
      session = data;
    }
    const history = cleanMessages(session?.messages);
    const safeContext = {
      weightKg: Number(context.weightKg) > 0 ? Number(context.weightKg) : null,
      bmr: Number(context.bmr) > 0 ? Number(context.bmr) : null,
      tdee: Number(context.tdee) > 0 ? Number(context.tdee) : null,
      dailyTarget: Number(context.dailyTarget) > 0 ? Number(context.dailyTarget) : null,
      todayCalories: Number(context.todayCalories) >= 0 ? Number(context.todayCalories) : 0,
      todayDate: trimText(context.todayDate, 10),
    };
    const contextText = "Konteks aplikasi terbaru (gunakan hanya bila relevan): " + JSON.stringify(safeContext);
    const parts: any[] = [{ text: BASE_INSTRUCTIONS + "\n" + contextText + "\nRingkasan percakapan sebelumnya: " + trimText(session?.memory_summary, 1800) }];
    const contents: any[] = [...history];
    const userParts: any[] = [];
    if (input) userParts.push({ text: input });
    if (image) userParts.push({ inline_data: { mime_type: image.mimeType, data: image.data } });
    contents.push({ role: "user", parts: userParts });

    const schema = {
      type: "OBJECT",
      properties: {
        reply: { type: "STRING" },
        items: { type: "ARRAY", items: { type: "OBJECT", properties: {
          name: { type: "STRING" }, portion: { type: "STRING" }, calories: { type: "INTEGER" }
        }, required: ["name","portion","calories"] } },
        totalCalories: { type: "INTEGER" },
        note: { type: "STRING" },
      },
      required: ["reply","items","totalCalories","note"],
    };
    // Bound each upstream call so a slow Gemini response cannot consume the
    // entire Supabase Edge Function wall-clock budget (150s on Free).
    const requestGemini = async (model: string, attempts = 2) => {
      const endpoint = "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + encodeURIComponent(apiKey);
      const requestBody = JSON.stringify({ system_instruction: { parts }, contents, generationConfig: { responseMimeType: "application/json", responseSchema: schema } });
      let response: Response | null = null;
      let payload: any = {};
      for (let attempt = 0; attempt < attempts; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 22000);
        try {
          response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: requestBody, signal: controller.signal });
          payload = await response.json().catch(() => ({}));
        } catch (error) {
          const timedOut = controller.signal.aborted;
          console.warn("Gemini request failed", model, timedOut ? "timeout" : String(error));
          response = new Response(JSON.stringify({ error: { message: timedOut ? "Gemini request timed out." : "Gemini request failed." } }), { status: 504 });
          payload = { error: { message: timedOut ? "Gemini request timed out." : "Gemini request failed." } };
        } finally {
          clearTimeout(timeout);
        }
        if (response.ok || ![429, 500, 502, 503, 504].includes(response.status) || attempt === attempts - 1) break;
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
      return { response: response!, payload };
    };
    let { response: gemini, payload } = await requestGemini("gemini-3.8-flash", 2);
    if (!gemini.ok && [429, 500, 502, 503, 504].includes(gemini.status)) {
      console.warn("Primary Gemini model unavailable; trying one bounded fallback", gemini.status);
      const fallback = await requestGemini("gemini-3.5-flash-lite", 1);
      gemini = fallback.response;
      payload = fallback.payload;
    }
    if (!gemini.ok) {
      console.error("Gemini error", gemini.status, payload?.error?.message);
      const status = gemini.status === 429 ? 429 : 502;
      const message = [429, 503, 504].includes(gemini.status)
        ? "Layanan Gemini sedang padat. Tunggu sebentar, lalu coba lagi."
        : "Gemini belum bisa memproses pesan ini. Coba lagi.";
      return reply({ error: message }, status);
    }
    const raw = payload?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("") || "";
    let result: any;
    try { result = JSON.parse(raw); } catch { return reply({ error: "Respons AI tidak terbaca. Coba kirim ulang." }, 502); }
    const items = Array.isArray(result.items) ? result.items.slice(0, 20).map((x: any) => ({
      name: trimText(x.name, 100), portion: trimText(x.portion, 100),
      calories: Math.max(0, Math.min(10000, Math.round(Number(x.calories) || 0))),
    })).filter((x: any) => x.name) : [];
    const totalCalories = items.reduce((sum: number, x: any) => sum + x.calories, 0);
    const assistantText = trimText(result.reply, 2500) || "Ini estimasi yang bisa gue bantu hitung.";
    const newHistory = [...history, { role: "user", text: input || "[Foto makanan]" }, { role: "model", text: assistantText }].slice(-MAX_ACTIVE_MESSAGES);
    let summary = trimText(session?.memory_summary, 1800);
    const priorCount = Array.isArray(session?.messages) ? session.messages.length : 0;
    if (priorCount + 2 > MAX_ACTIVE_MESSAGES) {
      const old = newHistory.slice(0, Math.max(0, newHistory.length - 6));
      if (old.length) summary = trimText([summary, old.map((m: any) => m.role + ": " + m.text).join("\n")].filter(Boolean).join("\n").slice(-1800), 1800);
    }
    const savedMessages = newHistory.slice(-6);
    const row = { user_id: userData.user.id, title: session?.title || (input || "Analisis foto").slice(0, 60), memory_summary: summary, messages: savedMessages, updated_at: new Date().toISOString() };
    let saved;
    if (session?.id) {
      const { data, error } = await db.from("ai_chat_sessions").update(row).eq("id", session.id).eq("user_id", userData.user.id).select("id").single();
      if (error) throw error; saved = data;
    } else {
      const { data, error } = await db.from("ai_chat_sessions").insert(row).select("id").single();
      if (error) throw error; saved = data;
    }
    return reply({ sessionId: saved.id, reply: assistantText, items, totalCalories, note: trimText(result.note, 400) });
  } catch (error) {
    console.error("ai-calorie-chat failed", error);
    return reply({ error: "Permintaan gagal diproses. Coba beberapa saat lagi." }, 500);
  }
});