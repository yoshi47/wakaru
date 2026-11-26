# 日本語会議モードと用語集: en の幻聴から実発話を守る

## 背景

2026-11-25 の日本語会議（61分、Chrome 159、PLaMo WebGPU）のログから。

- en 認識器の幻聴を 132 回破棄したが、29 回は字幕として採用された。すべて英語の幻聴で、`Website system`、`Foreign`、`Hi hi thank you this George`、`I pulled on the team I could always all this` など。
- ja の実発話を 9 回破棄した。うち 3 件は内容が完全に消えた。
  - 11:09:23 の「12月1日のウェブサイト公開、スポンサー募集、システム/スポンサーチーム」の報告（en `Website system` が引き金）
  - 11:21:19 の会場下見の候補日（en STALL `Hi` が引き金）
  - 11:28:39 の en `Hi hi this is` 採用 → ja `はい` 破棄 → 11:29:23 の新設スポンサープラン約45秒を `rest of a stuck start` として破棄
- STALL と本確定の二重表示が 34/264 段落（13%）。`#6`+`#7` → `#8`（380字）、`#29`〜`#32` など。
- 専門用語の認識崩れ: 稟議 → リンギ/臨機/林業/演技/リング、広報 → 会長/候補/甲府、会場 → 解除、サイドイベント → サイトイベント、ノベルティ → ノビリティ/モビリティ、キーキャップ → ギキャップ、ブレイクアウトルーム → ブレーカルトルーム。

## 目的

1. en の幻聴で ja の実発話が消えないようにする。
2. 日本語会議では en 認識器を止め、偽英語字幕と無駄な CPU をなくす。
3. 会議の用語を `SpeechRecognition.phrases` で寄せる。既定の用語集を用意し、設定から編集できるようにする。
4. `</S>` などの認識器の特殊トークンを表示から落とす。

やらないこと:

- STALL と本確定の置換（段落の `revise`）。別 PR。今回の二重表示は残るが、言語モードと保護でデータはきれいになる。
- `paragraphMaxGapMs` / `paragraphMaxTokens` / `stallMs` の調整。修正後のログで再測する。
- 音声の VAD（`speechend` や RMS）への置き換え。段落の無音測定は現状の途中経過ベースのまま。
- 用語の事後置換（`TS会議` → `TSKaigi` など）。まずコンテキストバイアスだけで試す。

## 1. StallFinalizer の保護（`src/asr/stallFinalizer.ts`）

### 1.1 実質日本語を en の stuck start として捨てない

`#stuckStart` は、ja の途中経過が en より先に止まったというだけで捨てる。en の幻聴でも同じことが起きる。ja の途中経過に平仮名・漢字が4文字以上あれば、en の stuck start とみなさない。

```ts
const JA_SUBSTANTIAL = /[\p{Script=Hiragana}\p{Script=Han}]/gu;
const substantialJa = (text: string) => (text.match(JA_SUBSTANTIAL)?.length ?? 0) >= 4;

#stuckStart(lang: Lang, s: State): boolean {
  if (lang === 'ja' && substantialJa(s.text)) return false;
  return s.changedAt < (this.#heardAt.get(other(lang)) ?? -Infinity);
}
```

Arbiter の `substantialJa` と同じ基準。片仮名は数えない（英語の発話を ja 側が片仮名で書くことがあるため）。`No`、`EX`、`うん`（2文字）は今までどおり捨てる。`flush` でも同じ保護を先に通す。認識器が終わるとき、他の言語が聞こえていても実質日本語は確定する。

### 1.2 捨てた短い頭の続きが実質日本語なら通す

`onRealFinal` は `stalled.discarded` のとき、続きを無条件に捨てる。`はい` を en の stuck start として捨てた後、次の `はいはいこんな感じです…` の全体が `rest of a stuck start` として消えた。続きが実質日本語なら、新しい発話として通す。

```ts
if (rest !== null && stalled?.discarded) {
  if (lang === 'ja' && substantialJa(rest)) {
    this.#heardAt.set(lang, now);
    return rest;
  }
  this.#onDiscard(lang, rest, 'rest of a stuck start');
  return null;
}
```

`No ウォーリーズ` の続きは片仮名だけなので、今までどおり捨てる。

### 1.3 テスト

`tests/stallFinalizer.test.ts` に追加:

- ja の長い実発話 + en `Website system` が後から来ても、ja を破棄せず STALL として確定する。
- ja `はい` を en `Hi` の stuck start として捨てた後、ja `はいはいこんな感じです…` の続きは通す。
- 既存の `No` / `EX` / `うん` / `No ウォーリーズ` は今までどおり捨てる（回帰）。

`tests/stallArbiter.test.ts` に、11:09:23 と 11:29:23 の時系列を追加する。

## 2. 言語モード（`auto` / `ja` / `en`）

### 2.1 設定

`src/settings.ts`:

```ts
export type LangMode = 'auto' | 'ja' | 'en';
export type Settings = {
  // ...
  langMode: LangMode;
  glossary: string[];
};
export const DEFAULT_SETTINGS: Settings = {
  // ...
  langMode: 'auto',
  glossary: [...DEFAULT_GLOSSARY],
};
```

`loadSettings` は `langMode` を3値で検証し、`glossary` は文字列の配列だけ受け付ける。古い保存値には既定を入れる。`saveSettings` は `Pick<Settings, 'engine' | 'langMode' | 'glossary'>` を保存する。既存のコメント（engine だけを保存する理由）を、ユーザーが選ぶ3つを保存する形に直す。

### 2.2 認識器

`src/asr/dualRecognizer.ts` のコンストラクタを options に変える。

```ts
type Options = { langs?: readonly Lang[]; now?: () => number; glossary?: readonly string[] };
constructor(source: MediaStreamTrack, events: RecognizerEvents, opts: Options = {}) { ... }
```

`start()` は `this.#langs` だけを起動する。`#langs` は `Session` から渡す。

`src/sidepanel/session.ts`:

```ts
const LANGS: Record<LangMode, readonly Lang[]> = { auto: ['ja', 'en'], ja: ['ja'], en: ['en'] };
const langs = LANGS[settings.langMode];
s.#recognizer = new DualRecognizer(s.#audio.track, { ... }, { glossary: settings.glossary, langs });
```

`started` のログに `langs=ja` を足す。

### 2.3 準備と起動

`src/sidepanel/main.ts`:

- `LOCALES` を `langMode` ごとの配列にする。`ja` では `ja-JP` だけ、`en` では `en-US` だけ。
- `prepareAll` の言語パックは必要なロケールだけ `install` する。Chrome 翻訳も必要な方向だけ作る（ja: ja→en、en: en→ja、auto: 両方）。PLaMo は方向を無視する。
- `ja` では `LanguageDetector` を作らない。readiness の detail は空。
- `preparableWithoutClick` も同じ条件で確認する。
- `startSession` の `!detector` チェックは `langMode !== 'ja'` のときだけ。`detect` には `detector?.detect ?? (async () => ({ lang: 'und', confidence: 0 }))` を渡す。ja だけなら Arbiter は `detect` を呼ばない。
- `switchEngine` と同様に、言語変更は idle / ready / error のときだけ受け付ける。変更したら readiness の langs / detector を pending に戻し、`langNeedsPrepare` を立てる。状態は idle / ready / error のまま変えない。次の「開始」クリック内で `prepareAll()` してから `startSession()` する（ヒーローとボタンの位置を動かさない）。

### 2.4 UI

言語は最初の画面（初回の PLaMo ダウンロード、idle）には置かない。開始待ち（`ready`）のヒーローと設定シートに3択のラジオ（自動 / 日本語 / 英語）を置く。初回・idle・error では設定だけ。

- 新規は日本語を既定にする。保存値があればそれを使う。英語/日英の会議は設定で変える。
- ヒーローの言語は `state === 'ready'` のときだけ表示。初回ダウンロード・idle・error・preparing / starting / running / stopping では `hidden`。
- 設定シートは翻訳エンジン + 聞き取る言語（3択） + 用語集（常時表示） + ログ（折りたたみ）。
- 説明は設定シートでは `?` のホバー/フォーカスで出す: 言語の auto 警告「英語側の誤認識が出ることがあります」、エンジンの比較、用語集。ヒーローの言語警告は auto のときだけ常時表示する（`?` は置かない）。状態表示（`engine-status`、`settings-note`）はそのまま。
- `#lang` / `#hero-lang` はそれぞれ独立したラジオにして、`settings.langMode` で同期する。
- `#hero-lang` は `ready` で編集可、`#lang` は `idle` / `ready` / `error` で編集可。`#settings-note` をエンジンと言語で共有する。

### 2.5 テスト

`tests/state.test.ts` は変更なし（Control は増やさない）。`tests/dualRecognizer` はブラウザ API 依存なので追加しない。手動で `?demo` と実機を確認する。

## 3. 用語集（`SpeechRecognition.phrases`）

### 3.1 既定の用語

`src/asr/glossary.ts` を追加する。公開されているカンファレンス運営用語（hyten の「カンファレンスあるある用語集」）と TSKaigi の公開チーム一覧、この会議のログから、32語を選ぶ。

- イベント: TSKaigi
- チーム: コアチーム、プログラム、会場、企画、スポンサー、配信、クリエイティブ、広報、システム、サイドイベント
- 運営: 稟議、サテライト、懇親会、ノベルティ、キーキャップ、タイムテーブル、ブレイクアウトルーム、スタンプラリー、クリアファイル、トートバッグ、エコバッグ、キックオフ、CFP、プロポーザル、基調講演、ブース、経費、ワークフロー、グループメンション、プルリク

辞書の定義文はコピーしない。単語だけのリストにする。boost は一律 3.0。4 以上は別の語を誤認識させるので使わない。

### 3.2 API

`src/types/web-ai.ts` に `SpeechRecognitionPhrase` と `phrases` を足す。`src/asr/dualRecognizer.ts` の `#launch` で、ja の認識器だけに設定する。

```ts
const Phrase = speechRecognitionPhrase();
const hints = phraseHints(this.#glossary);
if (Phrase && 'phrases' in rec && hints.length) {
  rec.phrases = hints.map((h) => new Phrase(h.phrase, h.boost));
}
```

`phrases` 非対応の Chrome では何もしない。`phrases-not-supported` が来たらログに残す（既存の `onerror` が拾う）。

### 3.3 設定 UI

設定シートに折りたたみの「用語集」を足す。

```html
<details class="dev">
  <summary>用語集（1行1語）</summary>
  <p class="hint">会議でよく出る言葉を入れると、聞き取りが寄ります。次の開始から反映されます。</p>
  <textarea id="glossary" rows="8" aria-label="用語集"></textarea>
</details>
```

`main.ts` で `settings.glossary.join('\n')` を初期値にし、`change` で保存する。空行は落とす。

### 3.4 テスト

`tests/glossary.test.ts`:

- `phraseHints` が trim / 空行除去 / 重複除去をする。
- 既定の用語集に `稟議`、`広報`、`会場`、`TSKaigi` が入っている。
- 既定に重複がない。

## 4. `</S>` の除去

`src/asr/normalize.ts` で、`normalize` の入口に `text.replace(/<\/S>/g, ' ')` を足す。ja / en の両方。`DualRecognizer.onresult` でも transcript から先に落とす。interim と final の比較を揃えるため。`tests/normalize.test.ts` に `E </S>` → `E`、`Hi </S>` → `Hi`、`はい </S>` → `はい` を追加する。

## 確認

1. `pnpm test`
2. `pnpm typecheck`
3. `pnpm build`
4. `?demo` で初回/idle に言語選択が出ないこと、ready に3択と auto 警告が出ること、設定の3択、設定の `?` ホバーで説明が出ること、用語集（常時表示）/ログ（折りたたみ）を確認する。
5. 実機で、`ja` モードの開始 → 停止 → 再開始。言語パックが ja だけになること、en の `decided` が出ないこと、`started ... langs=ja` をログで確認する。
6. 可能なら 2026-11-25 の会議録音を再生して、3件の消失が再現しないこと、偽英語字幕が出ないこと、用語の認識が改善することを見る。

## リスク

- `SpeechRecognition.phrases` の ja-JP での効き方は未検証。効かない場合は、用語集は設定に残るが認識は変わらない。次の会議ログで判断する。
- `ja` モードでは英語の発話が ja 認識器の片仮名になる。日英混在の会議では `auto` を使う。
- `substantialJa` の4文字は Arbiter と同じ。`そうですね`（5文字）は保護されるので、英語発話の頭に ja 側が `そうですね` を幻聴した場合は小さい重複が出る。消えるよりはよい。
- `#stuckStart` の保護で、en の発話の頭に ja 側が実質日本語を幻聴した場合、その幻聴が字幕になる可能性がある。頻度は次のログで見る。
- `auto` では、捨てた短い頭の続きを後から通すと、同じ区間の en 字幕と重なることがある。`ja` モードでは起きない。
- `auto` では短い ja の返事が en の幻聴に負けることがある（例: はい vs Website system）。`ja` モードでは起きない。設定の言語選択で回避する。
- 新規の既定は日本語（パネルの言語）。英語会議・日英混在の会議では、設定で `en` か `auto` に変える。既存の保存値が `auto` ならそのまま。

## 結果（2026-11-26）

実装した。

- `src/asr/stallFinalizer.ts`: 実質日本語を en の stuck start として捨てない。捨てた短い頭の続きが実質日本語なら通す。
- `src/asr/dualRecognizer.ts`: `langs` / `glossary` の options。ja だけの起動。ja の `SpeechRecognition.phrases`。`phrases-not-supported` のフォールバック。
- `src/sidepanel/session.ts`: `langMode` から起動する認識器を決める。`started ... langs=… glossary=…` をログに足す。
- `src/sidepanel/main.ts` / `index.html` / `style.css`: 初回ダウンロードから言語選択を削除、開始待ち（`ready`）のヒーローと設定に3択（既定は日本語）、言語切り替えでは状態を戻さず次の開始で準備、設定の説明は `?` ホバー、ヒーローの auto 警告は常時表示、用語集（常時表示）/ログ（折りたたみ）、モードごとの言語パックと detector の準備。
- `src/settings.ts`: `langMode` / `glossary` の保存。
- `src/mt/backend.ts` / `src/mt/chrome.ts`: 必要な翻訳方向だけ `prepare` する。ja モードで en→ja が unavailable でも開始できる。
- `src/asr/glossary.ts`: 既定32語（hyten のカンファレンス用語集、TSKaigi の公開チーム一覧、この会議のログから）。
- `src/asr/normalize.ts`: `</S>` の除去。
- テスト: `stallFinalizer` 2件、`stallArbiter` 2件、`glossary` 4件、`normalize` 1件を追加。

確認:

- `pnpm test`: 177 passed
- `pnpm typecheck`: passed
- `pnpm build`: passed

未確認:

- `SpeechRecognition.phrases` が ja-JP で実際に効くか。次の会議ログの `ja phrases not set` / `phrases not supported` と認識結果で判断する。
- `?demo` の見た目と、実機の言語切り替え。
- 既定の用語集の過剰バイアス（`会場` と `開場` など）。次のログで調整する。

残り:

- STALL と本確定の置換（段落の `revise`）。別 PR。今の保護で、長い ja が STALL で出た後に本確定が来ると重複しうる（`tests/stallFinalizer.test.ts` の「known duplicate」で固定）。
- `paragraphMaxGapMs` / `paragraphMaxTokens` / `stallMs` の再調整。言語モードと保護の後のログで測る。

## 次の会議で見るログ

- `started (... langs=ja, glossary=32)` になっているか。
- `ja phrases not set` / `phrases not supported` が出ないか。出たら、用語集は効いていない。
- `ja discarded (stuck start)` が実質日本語で出ないか。出たら、`substantialJa` の基準を見直す。
- `decide en` が 0 件か（`ja` モード）。出たら、en 認識器が動いている。
- STALL と本確定の二重表示は残る。件数を数え、次の `revise` の計画に使う。
- 用語の認識（稟議、広報、会場、サイドイベント、ノベルティ、キーキャップ）が改善したか。過剰バイアス（会場/開場など）が出たら boost を 2 に下げる。


