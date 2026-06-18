# 即時翻譯字幕 · Live Translator (Web)

純前端的即時語音翻譯字幕工具，使用 Google Gemini Live Translate 模型。
**自己帶 API key、key 只存在你自己的瀏覽器，不經過任何伺服器、程式碼裡沒有任何金鑰。**

## 特色

- 🎤 **我說話**：抓麥克風，把你說的話即時翻成其他語言（可多語同時，如英＋日）
- 🎧 **聽對方**：分享瀏覽器分頁/螢幕的音訊（如 Google Meet、YouTube），即時翻成你看得懂的語言
- 🌐 自動偵測來源語言（70+ 語言）→ 翻成你勾選的目標語言
- 📝 一句一句顯示、每句換色、可往上捲檢視歷史
- 🔒 key 只存 `localStorage`（你的瀏覽器本機），不上傳

## 使用方式

1. 開啟網頁
2. 在「設定」貼上**你自己的** Gemini API key（[在這裡取得](https://aistudio.google.com/apikey)）→ 儲存
3. 選模式（我說話 / 聽對方）+ 勾要翻成的語言
4. 按「開始翻譯」
   - 我說話 → 允許麥克風權限後開始講話
   - 聽對方 → 選擇要分享的分頁/視窗/螢幕，**記得勾「分享音訊」**

## ⚠ 限制

- 瀏覽器**抓不到原生 Teams 桌面 App 的聲音**（資安限制）。Teams 桌面會議請用桌面版工具，或在會議中分享整個螢幕並勾選分享系統音訊。
- API key 存在瀏覽器中，**用同一台電腦/瀏覽器的人看得到**（這是純前端工具的本質）。請勿在公用電腦使用、勿把 key 給別人。
- 需要支援 `getUserMedia` / `getDisplayMedia` 的現代瀏覽器（Chrome / Edge）。

## 技術

- 純靜態前端（HTML + ES Module JS），無建置、無後端
- `@google/genai` JS SDK（從 esm.sh CDN 載入）
- Web Audio API 擷取音訊 → 16kHz PCM → Gemini Live API (WebSocket)
- 模型：`gemini-3.5-live-translate-preview`

## 隱私

這個工具不含任何後端。你的音訊與 API key 只在「你的瀏覽器 ↔ Google Gemini API」之間流動，不經過本專案作者的任何伺服器。
