import { GoogleGenAI, Modality } from "https://esm.sh/@google/genai@2.8.0";

const dbg = { in: 0, out: 0, turn: 0, msg: 0 };

// ───────── 常數 ─────────
const MODEL = "gemini-3.5-live-translate-preview";
const TARGET_RATE = 16000;
const SENT_END = /[。！？.!?…]/;
const SHORT = { "zh-Hant": "繁", "zh-Hans": "简", "en": "EN", "ja": "日", "ko": "韓" };
const NAME = { "zh-Hant": "繁體中文", "zh-Hans": "简体中文", "en": "English", "ja": "日本語", "ko": "한국어" };
const PALETTE = ["c0", "c1", "c2", "c3", "c4"];
const IDLE_FLUSH = 2500; // ms

// ───────── 狀態 ─────────
let mode = "mic";
let targets = ["zh-Hant"];
let running = false;
let sessions = [];      // [{lang, session}]
let audioCtx = null, stream = null, srcNode = null, procNode = null;
const pending = {};     // lang -> 未完成句緩衝
const lastTs = {};      // lang -> 最後片段時間
let colorI = 0;
let srcDisplay = "";    // 底部即時行顯示用
// ── 對照稿錄製 ──
let recSrc = [];        // 原文句子 [{ms, text}]（依序）
let recOut = {};        // lang -> 翻譯句子陣列（依序）
let srcAccum = "";      // 原文斷句累積
let recStartMs = 0;     // 開始錄製的時間基準
let srcSentStart = null;// 目前原文句的起始時間

// ───────── DOM ─────────
const $ = (id) => document.getElementById(id);
const dot = $("dot"), statusEl = $("status"), capEl = $("captions"), liveEl = $("live");

function setStatus(msg, cls = "") { statusEl.className = cls; statusEl.textContent = msg; }

// ───────── API key（localStorage） ─────────
function loadKey() {
  const k = localStorage.getItem("gemini_key") || "";
  $("apikey").value = k;
  $("keyState").innerHTML = k
    ? `<span class="ok">✓ 已設定 key（${k.slice(0, 6)}…${k.slice(-4)}），存於本機</span>`
    : `尚未設定 key。<a href="https://aistudio.google.com/apikey" target="_blank" style="color:var(--teal2)">取得 Gemini API key →</a>`;
}
$("saveKey").onclick = () => {
  const k = $("apikey").value.trim();
  if (!k) return;
  localStorage.setItem("gemini_key", k);
  loadKey(); setStatus("API key 已儲存", "ok");
};
$("clearKey").onclick = () => { localStorage.removeItem("gemini_key"); loadKey(); setStatus("已清除 key"); };

// ───────── 模式 / 語言 選擇 ─────────
$("modeSeg").querySelectorAll("button").forEach(b => {
  b.onclick = () => {
    if (running) return;
    $("modeSeg").querySelectorAll("button").forEach(x => x.classList.remove("active"));
    b.classList.add("active"); mode = b.dataset.mode; updateHint();
  };
});
$("langSeg").querySelectorAll(".chip").forEach(c => {
  c.onclick = () => {
    if (running) return;
    c.classList.toggle("on");
    targets = [...$("langSeg").querySelectorAll(".chip.on")].map(x => x.dataset.lang);
  };
});
function updateHint() {
  $("modeHint").textContent = mode === "mic"
    ? "對著麥克風講話。建議勾選對方的語言（如 English、日本語）。"
    : "按開始後選擇要分享的分頁/視窗/螢幕，並勾選「分享音訊」。適合 Google Meet、YouTube 等在瀏覽器裡的聲音。注意：原生 Teams 桌面 App 的聲音瀏覽器抓不到。";
}

// ───────── 字幕顯示 ─────────
function commit(lang, sentence) {
  sentence = sentence.trim();
  if (!sentence) return;
  (recOut[lang] = recOut[lang] || []).push(sentence);  // 錄入對照稿
  const atBottom = capEl.scrollHeight - capEl.scrollTop - capEl.clientHeight < 40;
  const div = document.createElement("div");
  div.className = "line " + PALETTE[colorI % PALETTE.length];
  if (targets.length > 1) {
    const tag = document.createElement("span");
    tag.className = "tag"; tag.textContent = SHORT[lang] || lang;
    div.appendChild(tag);
  }
  div.appendChild(document.createTextNode(sentence));
  capEl.appendChild(div);
  colorI++;
  if (atBottom) capEl.scrollTop = capEl.scrollHeight;
}
function splitSentences(buf) {
  let out = [], start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (SENT_END.test(buf[i])) { out.push(buf.slice(start, i + 1)); start = i + 1; }
  }
  return { sents: out, rest: buf.slice(start) };
}
function feed(lang, text) {
  pending[lang] = (pending[lang] || "") + text;
  lastTs[lang] = Date.now();
  const { sents, rest } = splitSentences(pending[lang]);
  sents.forEach(s => commit(lang, s));
  pending[lang] = rest;
}
setInterval(() => {
  const now = Date.now();
  for (const lang of targets) {
    if (pending[lang] && now - (lastTs[lang] || 0) > IDLE_FLUSH) {
      commit(lang, pending[lang]); pending[lang] = "";
    }
  }
  // 診斷計數（讓使用者不用開 F12 也看得到訊息流向）
  if (running) {
    const d = document.getElementById("dbg");
    if (d) d.textContent = `診斷｜總訊息:${dbg.msg}　來源辨識:${dbg.in}　翻譯輸出:${dbg.out}　turn文字:${dbg.turn}`;
  }
}, 300);
$("clearBtn").onclick = () => { capEl.innerHTML = ""; liveEl.textContent = ""; };

// ───────── 下載對照稿（原文 ↔ 翻譯，逐句） ─────────
function pad(n) { return String(n).padStart(2, "0"); }
function fmtTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}
$("dlBtn").onclick = () => {
  // 收尾：把還沒斷句的尾段也納入
  if (srcAccum.trim()) {
    recSrc.push({ ms: (srcSentStart || Date.now()) - recStartMs, text: srcAccum.trim() });
    srcAccum = "";
  }
  for (const lang of targets) {
    if (pending[lang] && pending[lang].trim()) {
      (recOut[lang] = recOut[lang] || []).push(pending[lang].trim()); pending[lang] = "";
    }
  }
  const langs = targets.slice();
  const n = Math.max(recSrc.length, ...langs.map(l => (recOut[l] || []).length), 0);
  if (n === 0) { setStatus("⚠ 尚無內容可下載", "err"); return; }

  const esc = s => '"' + String(s || "").replace(/"/g, '""') + '"';
  const header = ["#", "時間", "發言人", "原文（聽到）", ...langs.map(l => NAME[l] || l)];
  const rows = [header];
  for (let i = 0; i < n; i++) {
    const r = recSrc[i] || {};
    rows.push([i + 1, fmtTime(r.ms || 0), "", r.text || "", ...langs.map(l => (recOut[l] || [])[i] || "")]);
  }
  const csv = "﻿" + rows.map(r => r.map(esc).join(",")).join("\r\n");  // BOM 讓 Excel 正確顯示中文
  const d = new Date();
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  a.download = `翻譯對照_${ts}.csv`;
  a.click(); URL.revokeObjectURL(a.href);
  setStatus(`✅ 已下載對照稿（${n} 句）`, "ok");
};

// ───────── 重點摘要（Gemini 文字模型） ─────────
$("sumBtn").onclick = async () => {
  const key = (localStorage.getItem("gemini_key") || "").trim();
  if (!key) { setStatus("⚠ 請先設定 Gemini API key", "err"); return; }
  // 收集逐句原文（最忠實）；不足時退而用翻譯
  const lines = recSrc.map(r => r.text);
  if (srcAccum.trim()) lines.push(srcAccum.trim());
  let transcript = lines.join("\n");
  if (!transcript.trim()) {
    const anyLang = targets.find(l => (recOut[l] || []).length);
    if (anyLang) transcript = recOut[anyLang].join("\n");
  }
  if (!transcript.trim()) { $("sumOut").textContent = "（尚無內容可摘要）"; return; }

  const model = $("sumModel").value;
  $("sumBtn").disabled = true;
  $("sumOut").textContent = `摘要中…（${model}）`;
  try {
    const ai = new GoogleGenAI({ apiKey: key });
    const prompt =
`以下是一段會議／對話的逐句語音記錄。請用繁體中文（台灣用語）整理重點，格式：

## 主題
（一兩句總結這段在談什麼）

## 重點
- （條列關鍵內容，3-7 點）

## 決定／結論
- （若有明確決定或結論；沒有就寫「無明確結論」）

## 待辦／後續行動
- （若有 action item，註明負責人若提到；沒有就寫「無」）

逐句記錄：
${transcript}`;
    const resp = await ai.models.generateContent({ model, contents: prompt });
    $("sumOut").textContent = (resp.text || "（模型無回應）").trim();
    setStatus("✅ 摘要完成", "ok");
  } catch (e) {
    $("sumOut").textContent = "❌ 摘要失敗：" + (e.message || e);
    setStatus("摘要失敗", "err");
  }
  $("sumBtn").disabled = false;
};
$("sumCopy").onclick = () => {
  const t = $("sumOut").textContent;
  if (t) { navigator.clipboard.writeText(t); setStatus("已複製摘要", "ok"); }
};

// ───────── 音訊：Float32 → 16k Int16 → base64 ─────────
function downsample(f32, inRate) {
  if (inRate === TARGET_RATE) return f32;
  const ratio = inRate / TARGET_RATE, n = Math.floor(f32.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = f32[Math.floor(i * ratio)];
  return out;
}
function toBase64Int16(f32) {
  const i16 = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    let s = Math.max(-1, Math.min(1, f32[i]));
    i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const bytes = new Uint8Array(i16.buffer);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// ───────── 開始 / 停止 ─────────
$("startBtn").onclick = () => running ? stop() : start();

async function start() {
  const key = (localStorage.getItem("gemini_key") || "").trim();
  if (!key) { setStatus("⚠ 請先在設定輸入你的 Gemini API key", "err"); return; }
  if (!targets.length) { setStatus("⚠ 請至少勾選一個翻譯語言", "err"); return; }

  // 新一輪 → 重置對照稿錄製
  recSrc = []; recOut = {}; srcAccum = ""; srcDisplay = "";
  recStartMs = Date.now(); srcSentStart = null;
  dbg.msg = dbg.in = dbg.out = dbg.turn = 0;

  try {
    setStatus("正在取得音訊…");
    if (mode === "mic") {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } else {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      if (!stream.getAudioTracks().length) {
        setStatus("⚠ 沒抓到音訊 — 分享時請記得勾選「分享音訊」", "err");
        stream.getTracks().forEach(t => t.stop()); return;
      }
    }

    const ai = new GoogleGenAI({ apiKey: key });
    sessions = [];
    setStatus("連線 Live Translate…");
    for (const lang of targets) {
      pending[lang] = ""; lastTs[lang] = 0;
      const isPrimary = sessions.length === 0;
      const session = await ai.live.connect({
        model: MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          // 注意：SDK 對 translationConfig 不做 camelCase 轉換，整包直送 API，
          // 故內部欄位必須用 API 的 snake_case 格式，否則目標語言會被忽略。
          translationConfig: { target_language_code: lang, echo_target_language: true },
        },
        callbacks: {
          onopen: () => {},
          onmessage: (msg) => {
            const sc = msg.serverContent;
            if (!sc) return;
            dbg.msg++;
            if (sc.inputTranscription?.text) {
              dbg.in++;
              if (isPrimary) {
                const t = sc.inputTranscription.text;
                if (srcAccum === "") srcSentStart = Date.now();  // 記下這句開始時間
                srcDisplay = (srcDisplay + t).slice(-160);
                liveEl.textContent = "🔊 " + srcDisplay;
                srcAccum += t;
                const { sents, rest } = splitSentences(srcAccum);
                if (sents.length) {
                  const ms = (srcSentStart || Date.now()) - recStartMs;
                  sents.forEach(s => { const x = s.trim(); if (x) recSrc.push({ ms, text: x }); });
                  srcSentStart = null;
                }
                srcAccum = rest;
              }
            }
            if (sc.outputTranscription?.text) { dbg.out++; feed(lang, sc.outputTranscription.text); }
            // 備援：有些情況翻譯文字在 modelTurn 的 text part
            if (sc.modelTurn?.parts) {
              for (const p of sc.modelTurn.parts) {
                if (p.text) { dbg.turn++; feed(lang, p.text); }
              }
            }
            if (dbg.msg === 1) console.debug("首則訊息 serverContent keys:", Object.keys(sc));
          },
          onerror: (e) => setStatus("連線錯誤：" + (e.message || e), "err"),
          onclose: () => {},
        },
      });
      sessions.push({ lang, session });
    }

    // 音訊處理鏈
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: TARGET_RATE });
    srcNode = audioCtx.createMediaStreamSource(stream);
    procNode = audioCtx.createScriptProcessor(4096, 1, 1);
    srcNode.connect(procNode); procNode.connect(audioCtx.destination);
    procNode.onaudioprocess = (e) => {
      if (!running) return;
      const f32 = downsample(e.inputBuffer.getChannelData(0), audioCtx.sampleRate);
      const data = toBase64Int16(f32);
      for (const s of sessions) {
        try { s.session.sendRealtimeInput({ audio: { data, mimeType: "audio/pcm;rate=16000" } }); } catch (_) {}
      }
    };

    running = true;
    dot.classList.add("on");
    $("startBtn").textContent = "■ 停止";
    $("startBtn").classList.add("stop");
    setStatus("✅ 進行中 — " + (mode === "mic" ? "請開始說話" : "正在聽分享的音訊"), "ok");

    // 使用者按「停止分享」時自動停
    stream.getTracks().forEach(t => t.onended = () => stop());
  } catch (err) {
    setStatus("❌ 啟動失敗：" + (err.message || err), "err");
    cleanup();
  }
}

function stop() { setStatus("已停止"); cleanup(); }

function cleanup() {
  running = false;
  dot.classList.remove("on");
  $("startBtn").textContent = "▶ 開始翻譯";
  $("startBtn").classList.remove("stop");
  try { procNode && (procNode.onaudioprocess = null, procNode.disconnect()); } catch (_) {}
  try { srcNode && srcNode.disconnect(); } catch (_) {}
  try { audioCtx && audioCtx.close(); } catch (_) {}
  try { stream && stream.getTracks().forEach(t => t.stop()); } catch (_) {}
  for (const s of sessions) { try { s.session.close(); } catch (_) {} }
  sessions = []; audioCtx = stream = srcNode = procNode = null;
}

// ───────── 啟動 ─────────
loadKey(); updateHint();
