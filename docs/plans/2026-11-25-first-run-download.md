# 初回のモデルダウンロードを開始から切り離し、エンジンを選べるようにする

## 背景

初回、開始を押すと PLaMo のモデル（573MB）のダウンロードが始まる。開始の前に「「開始」を押すと、必要な言語パックや翻訳モデルをダウンロードしてから聞き取ります」と出てはいるが、主ボタンのラベルは 開始 のままで、573MB という数字は設定シートの中にしかない。押した人には「開始したのにダウンロードが始まった」と見える。

ダウンロード中は preparing で 閉じる しか押せず、終わると `prepareAll().then(startSession)` で自動的に聞き取りが始まる（`src/sidepanel/main.ts:318-320`）。長いダウンロード中に席を外すと、誰も聞いていないセッションが始まる。

Chrome 翻訳に切り替えれば 573MB は要らないが、その選択肢は設定シートの中にしかない。初回は PLaMo の準備を主役にし、その下に Chrome 翻訳で続ける道を置く。

## 方針

- 開始は「押したらすぐ聞き取りが始まる」ときだけ有効にする。PLaMo のモデル（573MB）は開始クリックではダウンロードしない
- engine=plamo かつ OPFS にモデルが無い idle では、主アクションをダウンロードにする。押すと `prepareAll()`（言語パック、言語判定、モデルのダウンロードと読み込み）を最後まで行い、ready で止める。開始はその後に出す
- 初回は「PLaMo の準備」をヒーローの見出しにし、大きな「ダウンロード（573MB）」を主、その下に小さく「Chrome 翻訳で続ける」を置く。説明は書かない。Chrome の Translator が使える環境でだけ Chrome のボタンを出し、選んだエンジンは `settings.engine` に保存する
- Chrome を選んだら、同じクリックで `prepareAll()` を始める（`Translator.create()` にジェスチャが要る）。PLaMo を選んだら、今までどおりダウンロードを始める
- 判定は `isFirstRun(state, backend.id, modelMissing)` の1か所に集める。`modelMissing` 単独で分岐しない。Chrome では `modelMissing` を false にし、起動時の文言と `engineStatusText` も engine を見る
- MVP の「準備ボタンは置かない」（`docs/plans/2026-11-20-mvp.md:121`）は毎回押すボタンの話。ここで出すのは初回のダウンロードだけで、状態遷移と `CONTROLS` は変えない
- ダウンロードのクリックはユーザー操作なので、クリック内で `install()` と `LangDetector.create()` も始められる（`main.ts:236-240`）
- 対象は PLaMo のモデルだけ。言語パックと Chrome 翻訳の初回準備は今のまま開始クリックの中で行う（`Translator.create()` はクリック内でないと拒否されうる、`main.ts:247`）
- 状態遷移は変えない。idle --prepare--> preparing --prepared--> ready の既存の遷移を使う（`src/sidepanel/state.ts:30-38`）
- ダウンロード中は preparing なのでエンジン切替はできない（既存の規則）。閉じて開き直せば `.part` から再開する（`src/mt/plamo/modelStore.ts:56-74`）

## 変更

### `src/sidepanel/state.ts`

- `isFirstRun(state, engine, modelMissing)` を足す。`state === 'idle' && engine === 'plamo' && modelMissing` のときだけ true。render とクリックの両方がこれを使う
- `canOfferChrome(jaToEn, enToJa)` を足す。どちらかが `'unavailable'` なら false。`downloadable` / `downloading` は、クリックの中で作ればダウンロードできるので true
- 冒頭のコメントを直す。「準備ボタンは常設しない」はそのまま。`prepare` はクリックなしの自動準備と、初回のダウンロードのクリックの両方から来る

### `src/sidepanel/messages.ts`（新規）

- `MODEL_MB`（`MODEL.bytes` から丸める。573MB を2か所に書かない）、`FIRST_RUN_LABEL`、`FIRST_MESSAGE` を置き、main.ts と demo.ts で共有する
- `FIRST_RUN_LABEL = 'PLaMo の準備'`（初回の見出し）。説明の文章は置かない
- `FIRST_MESSAGE` は「足りない言語パックや翻訳モデルをダウンロードして」に直す。PLaMo でモデルだけある場合に、翻訳モデルまで落とすと言わないため

### `src/sidepanel/main.ts`

- `modelMissing` を持つ。engine の判定は `isFirstRun` に任せ、`modelMissing` 単独で分岐しない
- 起動時: `onTargetChange` と `acceptTarget(await loadTarget())` より前に、plamo のときだけ `modelFile()` を見て `modelMissing` を決める。`acceptTarget` が render するので、最初の描画で開始が出ないようにする。無ければ `message = FIRST_RUN_LABEL`
- `autoPrepare()`: `modelFile()` を再確認して `modelMissing` を更新し、その直後に `message` と `render()` も更新する（availability の待ちの間、開始のままにしない）。availability が false のときは、`modelMissing` なら `FIRST_RUN_LABEL`、そうでなければ `FIRST_MESSAGE`
- `onStartClick` を `onPrimaryClick` に改名。`isFirstRun(state, backend.id, modelMissing)` なら `dispatch('prepare')` → `prepareAll()` で止める。`startSession()` を呼ばない
- この分岐では `await` しない。`modelFile()` をクリックの中で呼ぶと、`install()` と `Translator.create()` に必要なユーザー操作が切れる（`main.ts:222-248`）。判定は起動時と `autoPrepare()` で更新したフラグで行う
- `render()`: `first = isFirstRun(...)`。ヒーローの主を「ダウンロード（573MB）」、その下に「Chrome 翻訳で続ける」（`first && chromeAvailable` のときだけ）にする。トップバーの開始は「開始」のまま `disabled` にする（グレーアウト）。字幕が残っていても初回はヒーローを出す（`body[data-first-run]`）
- `chromeAvailable` を起動時に `translatorApi().availability()` で調べる（`checkChrome`）。demo では hook で与える。ヒーローに Chrome の副ボタン（`chromeHero`）を置き、`first && chromeAvailable` のときだけ出す
- `onChromeClick`: `switchEngine('chrome')` → `dispatch('prepare')` → `prepareAll()`。クリックの中で `Translator.create()` を始める
- エンジン切替の処理を `switchEngine(engine)` に切り出す。設定シートの切替と Chrome の選択で共有する
- `checkChrome` は `chromeAvailable` を更新して、初回なら `render()` するだけ。文言は `FIRST_RUN_LABEL` で固定し、Chrome のボタンの表示だけを変える
- `prepareAll()`:
  - `onProgress` で `phase === 'load'` になったら `modelMissing = false`。ダウンロードは終わってファイルがある。読み込みに失敗しても、次の開始から読み直せる
  - 失敗メッセージの「「開始」でもう一度試します」を、`modelMissing` なら「もう一度押すと、ダウンロードは続きから再開します」にする。主ボタンのラベルを名指しせず、操作を書く
- `engineStatusText()`: pending かつ `backend instanceof PlamoBackend && modelMissing` なら「モデル（573MB）のダウンロードが必要です」
- エンジン切替: Chrome にしたら `modelMissing = false`。PLaMo に戻したときは `autoPrepare()` が再判定する。切替は設定シートの中で、シートを閉じるまで開始は押せないので、数 ms の遅れは実害がない
- `mountDemo` の `set` に `modelMissing` を渡す

### `src/sidepanel/index.html` と `style.css`

- 左上の状態ラベル（未準備・準備中・準備完了など）をやめる。状態は主ボタン、スピナー、バナー、色の点で分かる。点はタブ名の横に置く。`#state-label` と `stateLabel` を消し、スピナーの `aria-label` には `STATE_LABEL` を残す
- 字幕が残っていても、初回はヒーローを出す（`body[data-first-run] .stream .hero { display: grid }`）。Chrome で一度使った後に PLaMo へ切り替え、モデルが無いときに、ヒーローが隠れてダウンロードのボタンが出ないのを避ける
- ヒーローのボタンを `.hero-actions` にまとめ、主を 48px / 220px、Chrome の副を 34px / 160px にして縦に並べる

### `src/sidepanel/demo.ts`

- `set(state, message, readiness, modelMissing, chromeAvailable)` にする。idle 場面は `FIRST_RUN_LABEL`、true、true にする。モデルを消さずに PLaMo の準備と Chrome のボタンを確認できるようにする

### テスト

- `tests/state.test.ts` に `isFirstRun` と `canOfferChrome` の真理値表を足す。idle × plamo × モデル無しだけ true、chrome・ready・error は false。Chrome はどちらかの方向が unavailable なら false
- 表示の分岐は DOM に依存するので、`?demo` と実機で確かめる（段落の計画と同じ方針、`docs/plans/2026-11-25-paragraphs.md:93`）。`?demo` は表示だけで、ハンドラは demo で早期 return する（`main.ts:300`）。クリックの経路は実機で確かめる

## 確認

1. `pnpm test`、`pnpm typecheck`、`pnpm build`
2. モデルが無い状態でパネルを開く。新しいプロファイルで入れるか、サイドパネルの DevTools で
   `await (await navigator.storage.getDirectory()).removeEntry('plamo-3-translate-0.8b-Q4_K_M.gguf')`
   - ヒーローに「PLaMo の準備」の見出し、大きな「ダウンロード（573MB）」、その下に「Chrome 翻訳で続ける」。トップバーは「開始」がグレーアウト。状態の文字は出ない（点だけ）。idle ではバナーが `data-quiet` なので、見出しはヒーローに出る（`main.ts:167-173`）
3. 「ダウンロード」を押すとダウンロードが始まり、終わると ready になって開始が出る。聞き取りは始まらない。開始を押すとすぐ聞き取る。モデルのダウンロードは走らない
4. 「Chrome 翻訳で続ける」を押すと Chrome に切り替わり、準備して ready になる。設定シートのエンジンも Chrome。開始を押すと聞き取る。次に開いたときは PLaMo の準備は出ない
5. ダウンロードを失敗させる（DevTools のオフラインなど）と idle に戻り、メッセージが「もう一度押すと、ダウンロードは続きから再開します」と言う。オンラインに戻して押すと続きから再開する
6. ダウンロード中に閉じて開き直すと PLaMo の準備の画面が戻り、押すと続きから再開する
7. ダウンロード中に対象タブを別のページへ移す。開始を押すと「開始できませんでした」になる。アイコンを押し直すと、モデルはあるので開始できる（`docs/plans/2026-11-20-mvp.md:125-126`）
8. 設定シートで Chrome → PLaMo に戻すと、モデルが無ければ PLaMo の準備の画面に戻る。Chrome の Translator が使えない環境では Chrome のボタンが出ない（`canOfferChrome` のテストで確認）
9. モデルがある状態では、今までどおり開いた時に自動で読み込んで ready になる。ダウンロード後に ready → lost になっても「開始」のまま
10. `?demo` の idle 場面で、PLaMo の準備の画面と Chrome のボタン、グレーアウトした開始、ヒーローを確認する（`data-first-run` で字幕があってもヒーローが出る）

## やらないこと

- 別画面のオンボーディング。初回のヒーローに PLaMo の準備と Chrome のボタンを出すだけにする
- Chrome 翻訳の準備を専用のウィザードにする。Chrome を選ぶクリック、または開始クリックの中で行う（`main.ts:247`）
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
- Chrome の選択肢は起動時の availability で決める。Chrome の更新などで後から使えるようになっても、パネルを開き直すまで出ない
- Chrome を選んで準備に失敗すると、エンジンは Chrome のまま。開始で再試行するか、設定で PLaMo に戻す。PLaMo の準備の画面は設定で戻すまで出ない
