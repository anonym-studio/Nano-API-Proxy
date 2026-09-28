## 0. 改訂情報

### 0.1 改訂履歴

| 版 | 日付 | 内容 |
|---|---|---|
| 1.0 | — | 初版 |
| 1.1 | 2026-09-28 | Chrome 公式ドキュメントと実装事例に基づく技術検証を反映（下記 0.2） |

### 0.2 v1.1 の主な変更点

1. **推論の実行場所を Offscreen Document から Service Worker に変更。** Chrome 138 以降、拡張機能の Service Worker に `LanguageModel` が公開されている。Offscreen Document は、利用できない環境でのフォールバックとして残す（§5）。
2. **Prompt API の呼び出し方を現行の仕様に合わせた。** `window.ai.languageModel` / `capabilities()` / `readily` などの旧 API は廃止し、`LanguageModel.availability()` / `create()` / `promptStreaming()` を使う（§2.3, §3.1）。
3. **Native Messaging の制約を追記した。** ホスト→Chrome 方向は 1 通あたり 1MB が上限であること、起動時に引数を渡せないこと、拡張機能 ID を固定する必要があること（§2.2, §5）。
4. **セキュリティ要件を追加した。** ローカル HTTP サーバーの DNS リバインディング対策と CORS の許可リスト、インターセプト対象オリジンの制限（§3.4, §5）。
5. **OpenAI リクエストと Prompt API の対応付けを明文化した**（§3.2）。
6. ディレクトリ名・アダプター構成・パーミッションを修正し、未確定事項を §8 に整理した。

### 0.3 前提環境

- Chrome 138 以降（Prompt API は 138 で安定版になった。拡張機能向けの Origin Trial は終了済みで、`aiLanguageModelOriginTrial` パーミッションや `trial_tokens` は不要）
- Gemini Nano のハードウェア要件：Windows 10+ / macOS 13+ / Linux / ChromeOS（Chromebook Plus）、空きストレージ 22GB、GPU（VRAM 4GB 超）または CPU（RAM 16GB・4 コア以上）、初回ダウンロード時は従量課金でないネットワーク

## 1. プロジェクト概要

### 1.0 拡張機能名（仮）

Nano API Proxy

### 1.1 目的

フロントエンドアプリや各種開発ツール（CLI、Python スクリプト、バックエンドサービスなど）の開発・結合テストの段階で、本番の LLM API（OpenAI、Anthropic、Gemini API など）の契約・課金・API キー設定をせずに、動作検証や UI の挙動確認をできる環境を提供する。

**非目標：** 本番用 LLM ゲートウェイの代替、出力品質の再現（Gemini Nano の応答品質・トークン数は本番モデルと一致しない）。

### 1.2 コアコンセプト（ハイブリッド・アーキテクチャ）

用途に応じて 2 つの動作モードを切り替えられる構成とする。

1. **ブラウザ内通信横取りモード（デフォルト / コア）：**
    - Chrome 単体で完結し、外部サーバーやローカルランタイムを常駐させない。
    - Web フロントエンドのソースコードを変更せずに、ページ内の `fetch` を捕捉して応答を差し替える。
2. **ローカル API サーバーモード（必要時のみ / オプション）：**
    - Chrome の外のアプリケーション（curl、Python、VS Code 拡張機能など）から使いたいときだけ、サイドパネルからワンクリックでローカル HTTP サーバー（Native Messaging Host）を起動する。
    - 停止ボタンを押したとき、または Chrome を終了したときに、サーバープロセスも自動で終了する。

- **常時可視化：** Chrome Side Panel で、ブラウザ内の通信と外部 HTTP 通信の両方のログとモデルの状態を一か所で監視・制御する。

## 2. システムアーキテクチャ

### 2.1 全体構造図

```
[ モードA: Web Application (Chrome Page) ]
      │ 1. fetch("https://api.openai.com/v1/chat/completions", { ... })
      ▼
[ interceptor.js (MAIN world, run_at: document_start) ]
      │ - window.fetch をラップし、対象 URL だけを捕捉（対象外は元の fetch へ素通し）
      │ 2. CustomEvent（リクエスト ID 付き）
      ▼
[ relay.js (ISOLATED world) ]
      │ 3. chrome.runtime.connect（1 リクエスト = 1 Port。Port の切断で中断を伝える）
      ▼
┌──────────────── Extension Service Worker ────────────────┐
│  [ Router / State Manager ]                               │
│   - 通信ログの収集とサイドパネルへの配信                   │
│   - Native Messaging Host の起動・終了の管理              │
│  [ InferenceQueue (FIFO) ]                                │
│   - モードA / モードB 共通。推論は 1 件ずつ実行する        │
│  [ Adapters + LanguageModel (Gemini Nano) ]               │
│   - OpenAI / Anthropic / Gemini 形式 ⇔ Prompt API の変換  │
│   - LanguageModel.create() / promptStreaming()            │
│  ※ SW で LanguageModel が使えない環境のみ Offscreen に委譲 │
└──────────────────────────▲────────────────────────────────┘
                           │ 4. Native Messaging（stdio / 32bit 長プレフィックス + UTF-8 JSON）
                           ▼
┌──────────── Local Native Messaging Host（Go 製の単一バイナリ）────────────┐
│  - Listen: 127.0.0.1:<port>（既定 8080。0.0.0.0 にはバインドしない）       │
│  - OpenAI 互換エンドポイント（/v1/chat/completions, /v1/models）          │
│  - Host ヘッダー検証、CORS 許可リスト、SSE 中継                           │
└──────────────────────────▲────────────────────────────────────────────────┘
                           │ 5. HTTP POST / SSE
                           ▼
[ モードB: 外部アプリケーション (Terminal / Python / VS Code 等) ]
```

### 2.2 2 つの通信経路の詳細

#### モードA：ブラウザ内通信横取り

- **MAIN world への注入：** `interceptor.js` を `world: "MAIN"`、`run_at: "document_start"`、`all_frames: true` で注入し、ページのスクリプトより先に `window.fetch` をラップする。対象オリジンは設定で変えられるようにするため、静的な `content_scripts` ではなく `chrome.scripting.registerContentScripts()` で動的に登録する。
- **設定の受け渡し：** MAIN world からは `chrome.*` API を使えない。そこで、`relay.js` が `chrome.storage` から読んだ設定（有効・無効、対象 URL パターン）を CustomEvent で `interceptor.js` に渡す。設定が届く前に `fetch` が呼ばれた場合は、短いタイムアウト付きで設定の到着を待ってから判定する。
- **リクエストの解釈：** `fetch(input, init)` の `input` が `Request` オブジェクトのこともあるため、`new Request(input, init)` で正規化してから本文を読む。`init.signal` の中断は Port の切断で Service Worker に伝え、推論も中断する。
- **CORS は発生しない：** 対象リクエストはネットワークスタックに渡さず、JavaScript の中で `new Response(ReadableStream)` を返す。このため CORS プリフライトやオリジン制限はかからない。
- **ストリーミング中継：** Gemini Nano が出力したトークン差分を、各 API の SSE 形式にエンコードして `ReadableStreamDefaultController.enqueue()` に流す。
- **対象外（Phase 1 時点）：** `XMLHttpRequest`（ブラウザ版 axios など）、ページ内の Web Worker やページ自身の Service Worker から発行される `fetch`。OpenAI / Anthropic の公式 SDK はブラウザでも `fetch` を使うため、主なユースケースはカバーできる。

#### モードB：Native Messaging によるローカル HTTP サーバー

- **起動とライフサイクル：**
    1. ユーザーがサイドパネルの「Start Server」をクリックする。
    2. Service Worker が `chrome.runtime.connectNative("com.local.nano.proxy")` を実行する。
    3. Chrome が、OS に登録されたバイナリ（`nano-proxy-host`）を子プロセスとして起動する。Chrome からホストに渡される起動引数は呼び出し元のオリジン（Windows では加えて `--parent-window`）だけで、任意の引数は渡せない。
    4. 拡張機能は最初のメッセージとして `{type:"start", port, allowedOrigins}` を送る。ホストは Listen に成功したら `{type:"ready", port}` を、失敗したら `{type:"error", code:"EADDRINUSE", port}` を返す。
- **リクエストの中継：**
    1. 外部アプリから `http://127.0.0.1:<port>/v1/chat/completions` にリクエストが届く。
    2. ホストはリクエスト ID を振って `{type:"request", id, method, path, headers, body, client}` を stdout に書き出す。複数のリクエストが同時に届くことがあるので、stdout への書き込みは排他制御する。
    3. 拡張機能は推論の結果を `{type:"response_start", id, status, headers}` → `{type:"chunk", id, data}`（複数回）→ `{type:"response_end", id}` の順にホストの stdin へ送る。HTTP クライアントが切断したら、ホストは `{type:"cancel", id}` を送る。
    4. ホストは受け取ったチャンクを HTTP クライアントに SSE（または JSON 一括）で返す。
- **メッセージサイズの制約：** ホスト→Chrome は 1 通あたり最大 1MB、Chrome→ホストは最大 64MiB。リクエスト本文を丸ごと 1 通で送るので、ホストは本文が約 900KB を超えるリクエストを `413 Payload Too Large` で拒否する。
- **stdout の扱い：** stdout は Native Messaging のプロトコル専用とし、ログはすべて stderr に出す。
- **停止とクリーンアップ：** 「Stop Server」のクリック、`port.disconnect()`、または Chrome の終了でパイプが閉じる。ホストは stdin の EOF を検知したら `http.Server.Shutdown`（短いタイムアウト付き）を呼び、プロセスを終了する。

### 2.3 Prompt API 利用方針（Chrome 138+）

| 項目 | 使う API | 備考 |
|---|---|---|
| 可用性チェック | `LanguageModel.availability(options)` | 戻り値は `unavailable` / `downloadable` / `downloading` / `available`。`create()` / `prompt()` と同じ options を渡す |
| モデルのダウンロード | `LanguageModel.create({ monitor })` | ユーザー操作（クリック）が必要。Service Worker からは開始できないため、サイドパネルのボタンから実行し、`downloadprogress` を表示する。`downloadable` の状態で `create()` すると数 GB のダウンロードが始まるので、推論経路からは呼ばない |
| セッション生成 | `LanguageModel.create({ initialPrompts, temperature, topK, signal })` | `temperature` / `topK` は拡張機能のコンテキストでのみ指定できる。上限は `LanguageModel.params()` で取得する |
| ストリーミング推論 | `session.promptStreaming(input, { signal, responseConstraint })` | チャンクは差分（増分）で届く |
| コンテキスト管理 | `session.contextWindow` / `session.contextUsage` / `session.measureContextUsage()` | 上限を超えると古い会話から自動で削除される（`contextoverflow` イベント）。1 回のプロンプトだけで上限を超える場合は `QuotaExceededError` |
| 中断・破棄 | `AbortSignal` / `session.destroy()` | リクエストごとにセッションを作り、終わったら破棄する |

## 3. 機能要件

### 3.1 状態管理と制御トグル（サイドパネル）

- **ブラウザ内インターセプトの制御：**
    - **Global Intercept ON/OFF：** ページ内 `fetch` の横取りを有効・無効にする。
    - **対象オリジン：** 既定は `http://localhost:*/*` と `http://127.0.0.1:*/*`。これ以外のオリジンは、ユーザーが明示的に追加した場合だけ対象にする（`optional_host_permissions` で権限を要求）。
    - **Active Origin Only：** 現在アクティブなタブのオリジンだけを対象にするフィルター。
- **ローカルサーバーの制御：**
    - **Server Status：** `NOT_INSTALLED`（ホスト未登録）/ `STOPPED` / `STARTING` / `RUNNING (:8080)` / `ERROR`
    - **Start / Stop ボタン：** ワンクリックで Native Host に接続・切断する。
    - **Port 設定：** 待ち受けポートを変更できる（既定は `8080`）。ポートが使用中だった場合は、代わりのポートの入力を促す。
- **Built-in AI の可用性監視：**
    - `LanguageModel.availability()` の結果を表示する。
    - 表示するステータスは `available`（利用可能）/ `downloadable`（ダウンロードボタンを表示）/ `downloading`（進捗を表示）/ `unavailable`（非対応端末）/ `unsupported`（`LanguageModel` 自体が存在しない。Chrome のバージョンが古いなど）。
    - 推論が GPU と CPU のどちらで実行されているかは API から取得できないため、表示しない。

### 3.2 API エミュレーション

#### エンドポイント互換仕様

| エンドポイント | 対象モード | メソッド | 実装フェーズ | 説明 |
|---|---|---|---|---|
| `.*\/v1\/chat\/completions$` | 両方 | `POST` | Phase 1（A）/ Phase 3（B） | OpenAI Chat Completions（`stream: true` なら SSE、`false` なら JSON 一括） |
| `.*\/v1\/models$` | 両方 | `GET` | Phase 3 | 固定のスタブを返す（`{"object":"list","data":[{"id":"gemini-nano","object":"model",...}]}`） |
| `.*\/v1\/messages$` | 両方 | `POST` | Phase 4 | Anthropic Messages API 互換（`message_start` / `content_block_delta` / `message_stop` などの SSE イベント） |
| `.*\/models\/[^/]+:(streamGenerateContent\|generateContent)$` | 両方 | `POST` | Phase 4 | Google Gemini API 互換（`streamGenerateContent` では `?alt=sse` に対応） |

アダプターは Service Worker の中で両モード共通に使うため、モードA / モードB のどちらでも同じエンドポイントを提供できる。

#### OpenAI リクエストと Prompt API の対応付け

| OpenAI の項目 | Prompt API での扱い |
|---|---|
| `messages[role=system/developer]` | 1 つに連結し、`initialPrompts` の先頭に `system` として置く（`system` は先頭にしか置けない） |
| 最後以外の `user` / `assistant` | `initialPrompts` に順番どおり入れる |
| 最後の `user` メッセージ | `promptStreaming()` の入力にする |
| `temperature` / `top_p` | `temperature` は `LanguageModel.params()` の上限で丸める。`top_p` は無視し、`topK` は既定値を使う |
| `max_tokens` / `max_completion_tokens` | Prompt API に同等の機能はない。出力を概算トークン数で数え、上限に達したらストリームを中断して `finish_reason: "length"` を返す |
| `response_format: {type:"json_schema"}` | `responseConstraint` にスキーマを渡す |
| `tools` / `n>1` / 画像入力 など | 対応しない。`400` と OpenAI 形式のエラー JSON を返す |
| `usage` | `measureContextUsage()` による概算値を返す（本番モデルのトークン数とは一致しない） |
| `model` | どの値でも受け付け、応答の `model` にはリクエストの値をそのまま返す（クライアントの検証を通すため） |

#### カスタム設定項目

- **System Prompt Override：** クライアントが送った system 指示を上書きし、テスト用の固定プロンプトを使う。
- **Latency & Jitter Simulation：** 最初のトークンが届くまでの遅延（TTFT）とトークン間隔（ms）を設定し、低速回線やモデルの高負荷時を再現する。
- **Context Safety：** `measureContextUsage()` で入力サイズを測り、`contextWindow` に収まるまで古いメッセージから削る。system は残す。

### 3.3 モニタリング・統合通信ログ

サイドパネル上で、**ブラウザ内の横取り通信と外部 HTTP 通信を同じ画面にリアルタイムで一覧表示する**。

- **表示バッジ：** `[IN-BROWSER]`（青）/ `[EXTERNAL-HTTP]`（緑）
- **表示項目：**
    - **Status：** 200 OK / 400 Bad Request / 413 / 500 Internal Error / Streaming... / Cancelled
    - **Source Info：** タブの URL（モードA）、またはクライアントの IP とポート（モードB）
    - **Timing：** 最初のトークンまでの時間（TTFT）、推論にかかった総時間、生成したトークン数（概算）、キューで待った時間
    - **Payload Details（アコーディオンで展開）：**
        - Request：Headers（`Authorization` はマスクする）、Prompt Messages（Role / Content）
        - Response：生の出力テキスト、ストリームのチャンク
- **保存：** Service Worker は停止されることがあるため、ログはメモリだけでなく `chrome.storage.session` にも保存する。上限は直近 200 件。

### 3.4 セキュリティ要件

- **ローカルサーバー：** `127.0.0.1` にだけバインドする。`Host` ヘッダーが `127.0.0.1:<port>` と `localhost:<port>` 以外のリクエストは `403` で拒否する（DNS リバインディング対策）。
- **CORS：** `Access-Control-Allow-Origin: *` は使わない。許可リスト（既定は `http://localhost:*` と `http://127.0.0.1:*`）に一致したオリジンだけを返す。
- **認証：** OpenAI SDK は API キーを必須とするので、`Authorization: Bearer <任意の値>` を受け付ける。設定でアクセストークンを指定した場合は、トークンが一致するリクエストだけを受け付ける。
- **インターセプト対象：** 既定では localhost 系オリジンに限る。任意のサイトが拡張機能経由で Gemini Nano を使えてしまうのを防ぐため。

## 4. UI / UX 設計（Chrome Side Panel）

主な UI には **Chrome Side Panel API（`chrome.sidePanel`）** を使う。ツールバーのアイコンをクリックしたら開くように、`chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` を設定する。

### 4.1 画面レイアウト案

```
+-------------------------------------------------------------+
|  Built-in AI: [ AVAILABLE ]                                 |
|  [●] Intercept: [ ON ]     [▶] Local Server: [ 8080 : RUN ] |
+-------------------------------------------------------------+
|  [ Tabs: Activity Logs | Server & Rules | Settings ]        |
+-------------------------------------------------------------+
|  Filter: [ All Sources ▼ ]                  [ Clear Logs ]  |
|-------------------------------------------------------------|
|  ● 14:02:11 [IN-BROWSER] POST /v1/chat/completions          |
|    Origin: http://localhost:5173 | 200 OK | TTFT: 110ms     |
|    Prompt: "ユーザー登録フォームのバリデーション案..."      |
|-------------------------------------------------------------|
|  ● 14:01:45 [EXTERNAL]   POST /v1/chat/completions          |
|    Client: 127.0.0.1 (curl)      | 200 OK | TTFT: 95ms      |
|    Prompt: "Hello, what model are you?"                     |
|-------------------------------------------------------------|
| [Detail Drawer: 選択中リクエストの詳細 JSON / レスポンス]   |
+-------------------------------------------------------------+
```

`downloadable` の状態では、ヘッダーに「モデルをダウンロード」ボタンと進捗バーを表示する。

## 5. 技術的課題と対策

| 懸念事項 | 課題 | 対応策 |
|---|---|---|
| **1. ゾンビプロセス** | ブラウザのクラッシュや終了後も、ローカルサーバーがポートをつかんだまま残るおそれがある。 | **stdin の EOF を監視する：** ホストは stdin が閉じたら Shutdown を呼んで終了する（Go では `bufio.Reader` の読み取りで `io.EOF` を検知する）。 |
| **2. ポートの衝突** | ポート 8080 などがすでに使われていると起動できない。 | **Listen 失敗を通知する：** ホストが `{type:"error", code:"EADDRINUSE"}` を返し、サイドパネルに「Port 8080 in use」と表示して、別のポートを入力してもらう。 |
| **3. 並列リクエスト** | ブラウザ内の通信と外部の通信が同時に来ると、推論が競合する。 | **FIFO キュー：** Service Worker にキューを置き、推論を 1 件ずつ実行する。待ち時間はログに記録する。キューの上限（既定 10 件）を超えたら `429` を返す。 |
| **4. MV3 Service Worker の停止** | 待機中や長いストリーミングの途中で Service Worker が終了することがある。 | 推論中は、呼び出し元との Port（モードAは `connect`、モードBは `connectNative`）が開いている状態を保つ。ただし、Port が開いていても 5〜6 分ほどで停止したという報告がある（Chromium issue 40733525）。Phase 1 で長時間ストリーミングを実機で検証し、停止を検知したら、リクエストを失敗扱いにしてログに記録し、Native Host に再接続する。 |
| **5. `LanguageModel` を使えないコンテキスト** | Chrome のバージョンやチャネルによっては、Service Worker に `LanguageModel` が公開されていない可能性がある。 | **Offscreen Document へのフォールバック：** SW で `typeof LanguageModel === 'undefined'` の場合だけ、`chrome.offscreen.createDocument({ reasons: ['WORKERS'], ... })` で文書コンテキストを用意し、推論を委譲する。Offscreen の中で使える拡張機能 API は `chrome.runtime` だけなので、やり取りはメッセージで行う。 |
| **6. モデルの初回ダウンロード** | `LanguageModel.create()` でダウンロードを始めるにはユーザー操作が必要で、SW からは開始できない。 | サイドパネルのボタンからダウンロードを実行する。推論経路では `available` 以外なら `503` を返し、サイドパネルに案内を表示する。 |
| **7. Native Messaging Host の登録** | 初回だけ、OS の所定の場所にホストのマニフェストを置く必要がある。`allowed_origins` にはワイルドカードを使えず、拡張機能 ID の指定が必要。 | **拡張機能 ID の固定：** `manifest.json` に `key` を入れて、パッケージ化していない拡張機能の ID を固定する。**登録スクリプト：** `install.sh`（macOS / Linux）と `install.ps1`（Windows。HKCU のレジストリに登録）を同梱する。登録先は下表のとおり。 |
| **8. Native Messaging のサイズ上限** | ホスト→Chrome は 1 通あたり 1MB まで。 | 大きいリクエスト本文は `413` で拒否する（§2.2）。 |
| **9. `fetch` 以外の通信** | XHR や Worker から発行された `fetch` は横取りできない。 | Phase 1 では対象外とし、制約として明記する。XHR のフックは Phase 4 で検討する。 |

#### Native Messaging Host マニフェストの登録先（ユーザー単位）

| OS | 場所 |
|---|---|
| macOS（Chrome） | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.local.nano.proxy.json` |
| Linux（Chrome） | `~/.config/google-chrome/NativeMessagingHosts/com.local.nano.proxy.json` |
| Windows | `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.local.nano.proxy`（既定値にマニフェストのパスを入れる） |

マニフェストの `path` は、macOS と Linux では絶対パスで書く必要がある。`type` は `"stdio"` にする。

## 6. パッケージ・ディレクトリ構成

```
nano-api-proxy/
├── manifest.json                  # MV3。permissions: sidePanel, storage, scripting, nativeMessaging, offscreen
│                                  #      host_permissions: http://localhost/*, http://127.0.0.1/*
│                                  #      optional_host_permissions: <all_urls>（ユーザーが対象を追加するとき）
│                                  #      key: 開発用に拡張機能 ID を固定
├── host-manifest.template.json    # Native Messaging Host の定義（path と allowed_origins はインストール時に埋める）
├── install.sh / install.ps1       # OS にホストのマニフェストを登録するスクリプト
│
├── host/                          # ローカル HTTP サーバー（Go の単一バイナリ）
│   ├── main.go                    # stdio の Native Messaging ⇔ HTTP サーバー
│   ├── go.mod
│   └── bin/nano-proxy-host        # ビルド済みの実行バイナリ（git 管理外）
│
├── sidepanel/
│   ├── index.html
│   ├── sidepanel.js               # サーバーの起動・停止、トグル、ログ表示、モデルのダウンロード
│   └── sidepanel.css
│
├── background/
│   ├── service-worker.js          # ルーター、Native Messaging の管理、コンテンツスクリプトの登録
│   ├── inference-queue.js         # FIFO キュー（両モード共通）
│   ├── offscreen.html             # フォールバック専用（§5 課題5）
│   └── offscreen.js
│
├── scripts/
│   ├── interceptor.js             # MAIN world 用（fetch をラップ）
│   └── relay.js                   # ISOLATED world 用（ページ ⇔ Service Worker の中継）
│
└── lib/
    ├── adapters/
    │   ├── openai-adapter.js
    │   ├── anthropic-adapter.js
    │   └── gemini-adapter.js
    ├── sse.js                     # SSE のエンコード
    └── prompt-api-wrapper.js      # LanguageModel のラッパー（可用性、セッション、コンテキスト管理）
```

## 7. 実装ロードマップ

- **Phase 1：ブラウザ内インターセプトの基盤（コア）**
    - `interceptor.js` と `relay.js` で `fetch` を横取りし、設定を受け渡し、中断を伝える。
    - Service Worker で `LanguageModel` による推論とストリーミング（OpenAI の SSE / JSON）を行う。
    - **検証項目：** SW 上で `LanguageModel` が使えるか、長いストリーミングの途中で SW が停止しないか（§5 課題4・5）。
- **Phase 2：サイドパネル UI とモニタリング**
    - ON/OFF のトグル、可用性の表示、モデルのダウンロード。
    - 通信ログのリアルタイム表示と `chrome.storage.session` への保存。
- **Phase 3：Native Messaging Host（ローカルサーバー）**
    - Go の単一バイナリ（§2.2 のプロトコル、§3.4 のセキュリティ要件）。
    - `install.sh` / `install.ps1` と、拡張機能 ID の固定。
    - サイドパネルからの起動・停止、ポート衝突の処理、`/v1/models`。
- **Phase 4：キュー・互換性の拡充**
    - 両モードのリクエストの調停（上限と `429`）。
    - Anthropic / Gemini アダプター、XHR のフック（検討）。

## 8. 未確定事項（実装時に実機で確認する）

1. 拡張機能の Service Worker 上で `LanguageModel` と `promptStreaming()` が安定して動くか。動かない場合は Offscreen にフォールバックする。
2. 長時間のストリーミング中に SW が停止するか。停止する場合、どのくらいの時間で停止するか。
3. `LanguageModel.params()` が返す `temperature` / `topK` の上限と既定値。
4. Gemini Nano の `contextWindow` の実際の値。§3.2 の Context Safety の閾値を決めるのに使う。
5. 複数のセッションを同時に実行したときの挙動。FIFO キューで 1 件ずつに制限する必要が本当にあるか確認する。
