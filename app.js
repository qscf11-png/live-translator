import { GoogleGenAI, Modality } from "https://esm.sh/@google/genai@1.21.0";

const dbg = { in: 0, out: 0, turn: 0, msg: 0 };

// ───────── 常數 ─────────
const MODEL = "gemini-3.5-live-translate-preview";
const TARGET_RATE = 16000;
const SENT_END = /[。！？.!?…]/;
const SHORT = { "zh-Hant": "繁", "zh-Hans": "简", "en": "EN", "ja": "日", "ko": "韓" };
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
let srcBuf = "";

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
function feed(lang, text) {
  pending[lang] = (pending[lang] || "") + text;
  lastTs[lang] = Date.now();
  let buf = pending[lang], out = [], start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (SENT_END.test(buf[i])) { out.push(buf.slice(start, i + 1)); start = i + 1; }
  }
  out.forEach(s => commit(lang, s));
  pending[lang] = buf.slice(start);
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
                srcBuf = (srcBuf + sc.inputTranscription.text).slice(-160);
                liveEl.textContent = "🔊 " + srcBuf;
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
