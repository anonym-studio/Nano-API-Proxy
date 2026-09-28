# Changelog

## v0.5.0

初回リリース。開発仕様書の Phase 1〜4 を実装し、実機（macOS / Chrome 138+）で動作確認済み。

- **モードA**：ページの `window.fetch` をブラウザ内で横取りし、Gemini Nano の応答をその場で返す（`interceptor.js` / `relay.js`）。対象オリジンはサイドパネルから変更可能。
- **モードB**：サイドパネルから起動・停止できるローカル HTTP サーバー（Go 製の Native Messaging Host、`127.0.0.1` のみ待受）。`install.sh` / `install.ps1` で初回セットアップ。
- **API互換アダプター**：OpenAI Chat Completions（`/v1/chat/completions`、SSE / JSON 一括、`/v1/models`）、Anthropic Messages API（`/v1/messages`）、Google Gemini API（`:generateContent` / `:streamGenerateContent`）。
- **サイドパネルUI**：Built-in AI の可用性表示とモデルダウンロード、Intercept トグル、ローカルサーバーの起動・停止、System Prompt Override、Latency/Jitter シミュレーション、リアルタイム通信ログ。
- **共通基盤**：両モードで共有する FIFO 推論キュー、Offscreen Document へのフォールバック（Service Worker で `LanguageModel` が使えない場合）。
- モードA検証用のデモアプリ（`demo/`）を同梱。
- 利用マニュアル（`docs/manual.md`）を追加。

既知の未検証事項は [README の検証状況](README.md#検証状況) と [開発仕様書 §8](<docs/Chrome Built-in AI (Gemini Nano) 通信インターセプト ＆ ローカルAPIプロキシ拡張機能 開発仕様書(Nano-API-Proxy).md>) を参照。
