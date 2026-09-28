# Nano-API-Proxy

Local HTTP &amp; In-Browser Proxy for Chrome Built-in AI

Chrome に内蔵された Gemini Nano（Prompt API）を使って、OpenAI などの LLM API を手元で再現する Chrome 拡張機能です。API キーの取得や課金をせずに、LLM を使うアプリの開発や結合テストを進められます。

**現在のバージョン：v0.5.0**（実機での動作検証済み。詳細は[検証状況](#検証状況)を参照）

## 特徴

- **ブラウザ内の通信を横取りする（モードA）**：Web アプリの `fetch` を拡張機能が捕捉し、Gemini Nano の応答を返します。アプリのコードを変える必要はありません。外部サーバーも不要で、CORS の制限もかかりません。
- **ローカル API サーバー（モードB）**：サイドパネルからワンクリックで `http://127.0.0.1:8080` に OpenAI 互換サーバーを起動します。curl、Python、VS Code 拡張機能など、Chrome の外のツールからも使えます。Chrome を終了するとサーバーも自動で止まります。
- **3 種類の API 互換**：OpenAI Chat Completions（`/v1/chat/completions`、SSE ストリーミングと JSON 一括の両方、`/v1/models`）、Anthropic Messages API（`/v1/messages`）、Google Gemini API（`:generateContent` / `:streamGenerateContent`）に対応します。
- **サイドパネルでの監視**：両モードのリクエスト、プロンプト、TTFT（最初のトークンまでの時間）、応答をリアルタイムで一覧表示します。
- **テスト用の設定**：System Prompt の上書きや、遅延・ゆらぎの再現ができます。

## クイックスタート

1. [Releases](../../releases) から最新の zip をダウンロードして展開する（または `git clone` する）。
2. `chrome://extensions` → デベロッパーモードを有効化 → 「パッケージ化されていない拡張機能を読み込む」で展開したフォルダを選択する。
3. サイドパネルを開き、Built-in AI が `AVAILABLE` になっていることを確認する（`DOWNLOADABLE` ならモデルをダウンロード）。
4. `demo/` フォルダのデモアプリでモードAの動作を確認する（詳細は [demo/README.md](demo/README.md)）。

詳しい手順・モードBのセットアップ・トラブルシューティングは **[利用マニュアル](docs/manual.md)** を参照してください。

## 動作要件

- Chrome 138 以降
- Gemini Nano のハードウェア要件：
  - OS：Windows 10 以降、macOS 13 以降、Linux、ChromeOS（Chromebook Plus）
  - ストレージ：空き容量 22GB 以上
  - 性能：VRAM 4GB 超の GPU、または RAM 16GB・4 コア以上の CPU
- モードBを使う場合：Native Messaging Host の実行バイナリ（Releaseに同梱）、または Go 1.22 以降（自前でビルドする場合）

## 制約

- 出力の品質とトークン数は本番のモデルと一致しません。UI の挙動や通信の流れを確かめる用途を想定しています。
- tools（function calling）、`n > 1`、画像入力には対応しません。
- 横取りできるのは `fetch` だけです。`XMLHttpRequest`（ブラウザ版の axios など）や、Worker の中から発行されたリクエストは対象外です。
- 横取りの対象は、既定では `localhost` / `127.0.0.1` のページだけです。
- 初回の推論リクエストは Gemini Nano モデルのウォームアップのため数十秒かかることがあります（2回目以降は速くなります）。

## 検証状況

実機（macOS / Chrome 138+、GPU バックエンドの `nano_v3_gpu_low_tier_model`）で以下を確認済みです。

| 項目 | 状態 |
|---|---|
| モードA（ブラウザ内 `fetch` 横取り、OpenAI形式） | ✅ 確認済み |
| モードB（ローカルHTTPサーバー、ストリーミング/非ストリーミング） | ✅ 確認済み |
| サイドパネルの Activity Log（TTFT・ステータス表示） | ✅ 確認済み |
| Gemini Nano の GPU バックエンドでの推論 | ✅ 確認済み |
| Anthropic / Gemini アダプター | 実装済み・簡易テスト済み（実機での網羅的な検証は未実施） |
| 長時間ストリーミング時の Service Worker 生存性（[開発仕様書](<docs/Chrome Built-in AI (Gemini Nano) 通信インターセプト ＆ ローカルAPIプロキシ拡張機能 開発仕様書(Nano-API-Proxy).md>) §8） | 未検証 |

## 実装フェーズ

1. **Phase 1**：ブラウザ内での `fetch` 横取りと、Gemini Nano によるストリーミング応答
2. **Phase 2**：サイドパネルの UI と通信ログ
3. **Phase 3**：Native Messaging Host（Go）によるローカル HTTP サーバー
4. **Phase 4**：Anthropic / Gemini API 互換アダプター、両モード共通のリクエストキュー

## ドキュメント

- [利用マニュアル](docs/manual.md)
- [デモアプリの使い方](demo/README.md)
- [開発仕様書](<docs/Chrome Built-in AI (Gemini Nano) 通信インターセプト ＆ ローカルAPIプロキシ拡張機能 開発仕様書(Nano-API-Proxy).md>)

## ライセンス

[MIT](LICENSE)
