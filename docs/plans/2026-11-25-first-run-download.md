# 初回のモデルダウンロードを開始から切り離す

## 背景

初回、開始を押すと PLaMo のモデル（573MB）のダウンロードが始まる。開始の前に「「開始」を押すと、必要な言語パックや翻訳モデルをダウンロードしてから聞き取ります」と出てはいるが、主ボタンのラベルは 開始 のままで、573MB という数字は設定シートの中にしかない。押した人には「開始したのにダウンロードが始まった」と見える。

ダウンロード中は preparing で 閉じる しか押せず、終わると `prepareAll().then(startSession)` で自動的に聞き取りが始まる（`src/sidepanel/main.ts:318-320`）。長いダウンロード中に席を外すと、誰も聞いていないセッションが始まる。

## 方針

- 開始は「押したらすぐ聞き取りが始まる」ときだけ出す。PLaMo のモデル（573MB）は開始クリックではダウンロードしない
- engine=plamo かつ OPFS にモデルが無い idle では、主アクションをダウンロードにする。押すと `prepareAll()`（言語パック、言語判定、モデルのダウンロードと読み込み）を最後まで行い、ready で止める。開始はその後に出す
- 判定は `isFirstRun(state, backend.id, modelMissing)` の1か所に集める。`modelMissing` 単独で分岐しない。Chrome では `modelMissing` を false にし、起動時の文言と `engineStatusText` も engine を見る
- MVP の「準備ボタンは置かない」（`docs/plans/2026-11-20-mvp.md:121`）は毎回押すボタンの話。ここで出すのは初回のダウンロードだけで、状態遷移と `CONTROLS` は変えない
- ダウンロードのクリックはユーザー操作なので、クリック内で `install()` と `LangDetector.create()` も始められる（`main.ts:236-240`）
- 対象は PLaMo のモデルだけ。言語パックと Chrome 翻訳の初回準備は今のまま開始クリックの中で行う（`Translator.create()` はクリック内でないと拒否されうる、`main.ts:247`）
- 状態遷移は変えない。idle --prepare--> preparing --prepared--> ready の既存の遷移を使う（`src/sidepanel/state.ts:30-38`）
- ダウンロード中は preparing なのでエンジン切替はできない（既存の規則）。閉じて開き直せば `.part` から再開する（`src/mt/plamo/modelStore.ts:56-74`）

## 変更

### `src/sidepanel/state.ts`

- `isFirstRun(state, engine, modelMissing)` を足す。`state === 'idle' && engine === 'plamo' && modelMissing` のときだけ true。render とクリックの両方がこれを使う
- 冒頭のコメントを直す。「準備ボタンは常設しない」はそのまま。`prepare` はクリックなしの自動準備と、初回のダウンロードのクリックの両方から来る

### `src/sidepanel/messages.ts`（新規）

- `MODEL_MB`（`MODEL.bytes` から丸める。573MB を2か所に書かない）、`MODEL_MISSING_MESSAGE`、`FIRST_MESSAGE` を置き、main.ts と demo.ts で共有する
- `MODEL_MISSING_MESSAGE = '翻訳モデル（573MB）のダウンロードが必要です。数分かかります。途中で閉じても、次に開いて押すと続きから再開します'`。「初回は」は付けない（退避の後にも出るため）。進行中の「パネルを閉じると中断」（`main.ts:195`）と矛盾しないよう、再開は開き直して押すことを書く
- `FIRST_MESSAGE` は「足りない言語パックや翻訳モデルをダウンロードして」に直す。PLaMo でモデルだけある場合に、翻訳モデルまで落とすと言わないため

### `src/sidepanel/main.ts`

- `modelMissing` を持つ。engine の判定は `isFirstRun` に任せ、`modelMissing` 単独で分岐しない
- 起動時: `onTargetChange` と `acceptTarget(await loadTarget())` より前に、plamo のときだけ `modelFile()` を見て `modelMissing` を決める。`acceptTarget` が render するので、最初の描画で開始が出ないようにする。無ければ `message = MODEL_MISSING_MESSAGE`
- `autoPrepare()`: `modelFile()` を再確認して `modelMissing` を更新し、その直後に `message` と `render()` も更新する（availability の待ちの間、開始のままにしない）。availability が false のときは、`modelMissing` なら `MODEL_MISSING_MESSAGE`、そうでなければ `FIRST_MESSAGE`
- `onStartClick` を `onPrimaryClick` に改名。`isFirstRun(state, backend.id, modelMissing)` なら `dispatch('prepare')` → `prepareAll()` で止める。`startSession()` を呼ばない
- この分岐では `await` しない。`modelFile()` をクリックの中で呼ぶと、`install()` と `Translator.create()` に必要なユーザー操作が切れる（`main.ts:222-248`）。判定は起動時と `autoPrepare()` で更新したフラグで行う
- `render()`: `first = isFirstRun(...)`。トップバーの開始を「準備」、ヒーローを「モデルをダウンロード」にする。どちらも毎回代入する（ready に戻ったときに「開始」へ戻す）
- `prepareAll()`:
  - `onProgress` で `phase === 'load'` になったら `modelMissing = false`。ダウンロードは終わってファイルがある。読み込みに失敗しても、次の開始から読み直せる
  - 失敗メッセージの「「開始」でもう一度試します」を、`modelMissing` なら「もう一度押すと、ダウンロードは続きから再開します」にする（ヒーローは字幕があると隠れるので、ボタン名を書かない）
- `engineStatusText()`: pending かつ `backend instanceof PlamoBackend && modelMissing` なら「モデル（573MB）のダウンロードが必要です」
- エンジン切替: Chrome にしたら `modelMissing = false`。PLaMo に戻したときは `autoPrepare()` が再判定する。切替は設定シートの中で、シートを閉じるまで開始は押せないので、数 ms の遅れは実害がない
- `mountDemo` の `set` に `modelMissing` を渡す

### `src/sidepanel/demo.ts`

- `set(state, message, readiness, modelMissing)` にする。idle 場面は `MODEL_MISSING_MESSAGE` と true にする。モデルを消さずに初回の表示を確認できるようにする

### テスト

- `tests/state.test.ts` に `isFirstRun` の真理値表を足す。idle × plamo × モデル無しだけ true、chrome・ready・error は false
- 表示の分岐は DOM に依存するので、`?demo` と実機で確かめる（段落の計画と同じ方針、`docs/plans/2026-11-25-paragraphs.md:93`）。`?demo` は表示だけで、ハンドラは demo で早期 return する（`main.ts:300`）。クリックの経路は実機で確かめる

## 確認

1. `pnpm test`、`pnpm typecheck`、`pnpm build`
2. モデルが無い状態でパネルを開く。新しいプロファイルで入れるか、サイドパネルの DevTools で
   `await (await navigator.storage.getDirectory()).removeEntry('plamo-3-translate-0.8b-Q4_K_M.gguf')`
   - ヒーローに 573MB の説明と「モデルをダウンロード」、トップバーに「準備」。idle ではバナーが `data-quiet` なので、説明はヒーローに出る（`main.ts:167-173`）
   - 押すとダウンロードが始まり、終わると ready になって開始が出る。聞き取りは始まらない
   - 開始を押すとすぐ聞き取りが始まる。モデルのダウンロードは走らない
3. ダウンロードを失敗させる（DevTools のオフラインなど）と idle に戻り、メッセージが「もう一度押すと、ダウンロードは続きから再開します」と言う。オンラインに戻して押すと続きから再開する
4. ダウンロード中に閉じて開き直すと、ダウンロードのアクションが戻り、押すと続きから再開する
5. ダウンロード中に対象タブを別のページへ移す。開始を押すと「開始できませんでした」になる。アイコンを押し直すと、モデルはあるので開始できる（`docs/plans/2026-11-20-mvp.md:125-126`）
6. Chrome 翻訳に切り替える（モデルが無いまま）と開始に戻る。PLaMo に戻すとダウンロードに戻る
7. モデルがある状態では、今までどおり開いた時に自動で読み込んで ready になる。ダウンロード後に ready → lost になっても「開始」のまま
8. `?demo` の idle 場面で、バナーとトップバーの「準備」を確認する。ヒーローはサンプル字幕で隠れる（`src/sidepanel/style.css:364`）ので、ヒーローの「モデルをダウンロード」は実機で見る。エンジンが Chrome のときは開始のままなので、PLaMo にしておく

## やらないこと

- Chrome 翻訳の初回準備を別ステップにする。翻訳モデルのダウンロードは開始クリックの中で行う（`main.ts:247`）
- パネルを開いた瞬間の自動ダウンロード。573MB を開いただけで始めない
- 最初のダウンロードの後に `.part` があれば開いた時に自動で再開する。今回はボタンで再開する
- error からの開始。error は聞き取りが止まった後なので、通常はモデルがそろっている
- モデルの削除・再ダウンロードの UI

## 既知の限界

- 起動後にモデルが OPFS から消えた場合（退避）は、開始クリックの中でダウンロードが始まる。`navigator.storage.persist()` を呼んでいるので通常は起きない
- `modelFile()` は OPFS の読み取り失敗も null にする（`src/mt/plamo/modelStore.ts:26-33`）。「モデルが無い」と同じ表示になり、押すとダウンロードが失敗してエラーが出る
- 2つのパネルが同時に開くと、後のパネルは LOCK 待ちの間 0% のまま（`src/mt/plamo/modelStore.ts:60-63`）。既存の制約
- ダウンロード中は preparing なので 閉じる しか押せない。エンジンを切り替えたいときは閉じて開き直す。既存の規則
- エンジン切替の直後、`modelFile()` の判定が終わるまでの数 ms は前の表示が残る。切替は設定シートの中で行い、シートを閉じるまで開始は押せないので実害はない
