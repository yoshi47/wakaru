# 段落字幕: 1人の話の断片を1つの字幕にまとめて訳し直す

## 背景

実際の会議（英語の朝会）で、1人が話し続けているのに字幕が断片に割れ、断片ごとに訳されて意味が取れなかった。
ログ（01:32:10〜01:32:33 の話者）では、1つの話が字幕 #4〜#10 の7個に割れた。

```
en FINAL "All right I finished the pr and then"
en STALL "I realized that"
en STALL "Like the"
en FINAL "Was not the only issue that was happening so like it was happening on"
en FINAL "Document layouts"
en STALL "Just for the anything that surprise or amount so I'm finishing testing my fix for that then it should be tested"
en FINAL "Just for the anything that's a price or a total amount so I'm finishing testing my fix for that then it should be tested"
```

原因:

1. StallFinalizer が、言いよどみ（途中経過が 1200ms 止まる）で文を確定扱いにする（`I realized that`、`Like the`）
2. Chrome の認識器も文の途中で FINAL を出す（`… happening on` / `Document layouts`）
3. STALL の直後に、単語が少し直った FINAL が来ると二重に出る。`StallFinalizer.onRealFinal` は、STALL の文が FINAL の頭と単語単位で完全に一致するときだけ重複とみなす（`src/asr/stallFinalizer.ts` の `after()` と `onRealFinal()`）
4. 判定（Decision）1件がそのまま字幕1つ・翻訳1件になる（`src/sidepanel/session.ts` の `#handle`）

## 方針

- 話者は区別しない。音声1本からは分からず、Chrome の認識器も話者をまたいで1つの FINAL を出す（ログの `Thank you good morning everyone …`）
- 区切りを間違えるなら、まとめすぎる側に倒す。2人分が1段落に入っても各文は読めるが、断片の訳（`Like the`）は意味が取れない
- 外部の LLM には送らない。文字起こしを外に出さない前提を保つ。Gemini Nano で整える段（句読点を付けて文につなぐ）は、この変更の後に別に検証する

2段階に分け、別々の PR にする。

- 段階1（原因1, 2, 4）: 同じ言語の判定が無音を挟まずに続いたら、前の字幕（段落）に足し、段落全体を訳し直す
- 段階2（原因3）: STALL の直後に来た同じ文の言い直しを、足さずに置き換える。消してはいけない発話を消しうる、いちばん危ない規則なので、段階1を実機で確かめてから入れる

やらないこと:

- `stallMs` の変更。断片は段落でつながるので、言いよどみで STALL が出ても読みやすさは落ちない。値は Task 6 で実測してから変える
- 認識誤り（`Patients but they record and`）の修正
- 英語の断片の先頭（Chrome が大文字にする）を小文字にすること。固有名詞（`Slack`、人名）まで変わる

### 参考: PLaMo の拡張の切り方

- tanakh/plamo-translate-desktop の拡張は、書かれた文章を訳す。空行で段落に分け、トークン数の上限まで詰め、超えたら改行 → 文末 → 空白の順に切る（`extension/translator.js` の `split()`）。音声認識の結果には句読点も改行もないので、この切り方は使えない
- PFN 公式の拡張（v0.9.1）のライブ音声翻訳は、同じ Chrome のオンデバイス音声認識を使い、確定結果1件ずつを、直前の5組を文脈につけて訳す。断片をまとめて訳し直す処理はない。表示だけ段落にまとめ、次の確定が来ないまま一定時間たつと閉じる。待ち時間は5秒から始まり、段落が上限に近づくほど1秒まで縮む
- 取り入れたのは、段落の長さで無音の閾値を縮める考え方だけ（コードは使わない）

---

## 段階1: 段落にまとめて訳し直す

### 区切り方（`src/asr/paragrapher.ts`）

「無音」は、どちらの言語の途中経過も変化しなかった時間で測る。判定の到着間隔では測らない。判定は `windowMs`（800ms）や `stallMs`（1200ms）の待ちを経て届くので、話し続けていても間隔が 2.5 秒空くことがある（ログの `Document layouts`）。

- Session は、空でない途中経過が前回と違う文になるたびに `heard(now)` を呼ぶ
  - 前回の文は言語と generation ごとに覚える。空文字（DualRecognizer は FINAL のたびに `''` を送る）は無視する
  - 本物の FINAL と `onEnd` のとき、その言語の前回の文を忘れる。無音の後に同じ文（「はい」）が来たときも変化とみなすため
- `heard` は、前回から `paragraphMinGapMs` 以上空いていたら、その無音を記録する（話が再開した時刻と長さ）
- 新しい判定は、次のどれかに当たれば新しい段落にする。どれにも当たらなければ開いている段落に足す
  - 開いている段落がない（最初の発話、またはクリアの後）
  - 段落の言語と違い、かつ短い返事ではない（`closed: lang`）
  - 段落の最後の断片の `firstAt` より後、新しい判定の `firstAt` 以前に、閾値以上の無音がある（`closed: gap`）
  - 足すと段落の推定トークン数（`estimateTokens`）が `paragraphMaxTokens` を超える（`closed: limit`）
- 無音の閾値は段落の長さで縮める: 上限の半分（40トークン）までは `paragraphMaxGapMs`、そこから上限まで線形に縮めて `paragraphMinGapMs`。初めから縮めると、1.8 秒の言いよどみ（2.0〜2.1 秒と測られる）で約38トークンの段落が4回に1回分かれ、最後の断片が単独で訳された（下の検証結果）

短い返事（ja は平仮名・漢字が8文字未満、en は3語以下）は、別の言語の段落を閉じない。それ自体の字幕になり、その後に元の言語が区切りなしに来たら、前の段落に足す。相づち（「うんうん」「そうですね」）や、Arbiter が日本語側の `OK` として採った英語の `Okay` が独白に挟まると、3段落に割れるため。Arbiter が中身のある発話とみなす基準（4文字）より高くしているのは、「うんうん」「そうですね」がその基準を超えるため。

`firstAt` を基準にする理由: STALL の `at` は途中経過が最後に変わった時刻、本物の FINAL の `at` は届いた時刻。どちらも「その発話の音声の後」なので、無音がその後にあれば、次の発話は無音の後に始まったと言える。

### 既定値（`src/settings.ts`、仮の値）

- `paragraphMaxGapMs`: 3000、`paragraphMinGapMs`: 1000
  - 測った無音は、本当の無音より 0〜0.55 秒長く出た（下の検証結果）。途中経過は話し終わりより前に変化が止まり、話し始めより後に最初の変化が来るため
  - 次の会議のログ（`silence …ms`）で決め直す
- `paragraphMaxTokens`: 80。日本語で80文字、英語で約55語。文字数で一律に切ると、日本語の段落だけ4倍のトークンになる
  - 訳し直し1回は GPU で1〜1.5秒の見込み（今回のログで約25トークンが 413ms）。キューの時間切れ 5000ms に収まる

### 翻訳

- PLaMo が CPU で動いているとき（`TranslatorBackend.fast` が false）は段落にまとめない（判定1件ごとの字幕と翻訳）。CPU では1件の翻訳が秒単位かかり、伸びる段落の訳し直しが時間切れを繰り返すため
- `Job.key` は段落。キューは、待っている同じ段落の Job を新しい版で置き換える（古い版の Outcome は出さない）。実行中の Job は最後まで訳す
- PLaMo の文脈（History）は段落ごとに1組。訳すときは、その段落の古い版を除いて渡す（`pairsExcept`）。古い版が文脈にあると、訳が前の訳を繰り返すか、続きだけを訳すおそれがある。訳し終えたら古い版と置き換える。`max_tokens` で切れたら古い版も消す

### 表示（`src/sidepanel/ui.ts`）

- 段落が伸びたら、原文を差し替える。訳がまだ一度も出ていなければ「翻訳中」のまま。出ていれば前の版の訳を残して薄くする（`stale`）。「翻訳中」に戻すと、伸びるたびに訳が消えてちらつく
- 最新の版の訳が出たら差し替えて、薄い表示を戻す。古い版の訳は、薄いまま差し替える
- 最新の版が失敗・省略されたら: 訳がまだなければ今どおりのエラー表示。あれば前の版の訳を残し、「続きは訳せませんでした」と添える
- 最新の版が省略された後に、実行中だった古い版の訳が届いたら: その訳を出し、「続きは訳せませんでした」と添える（薄いまま残さない）
- 停止したら、薄いまま残った訳にも「続きは訳せませんでした」と添える（停止は翻訳待ちを 5 秒で打ち切るので、後の訳は来ない）

表示の状態遷移には DOM のテストがないので、`?demo` と実機で確かめる。

### ログ（調整用）

- `silence ${ms}ms`: `paragraphMinGapMs` 以上の無音すべて
- `paragraph #${key} new|append (closed: gap|limit|lang)`
- `translate #${id} (paragraph #${key}) …ms, from firstAt …ms`: `firstAt` はその版で足した断片のものなので、訳し直しの遅れも測れる
- `started (… paragraphs=on|off)`

`closed: limit` ばかりなら、無音の信号が効いていない（画面共有の動画や BGM が途中経過を出し続けている）。

### 既知の限界

- 同じ言語で、隙間なく話者が替わると同じ段落になる（合意済みのコスト）
- 1人の間が閾値より長いと分かれる
- 本物の FINAL が、次の発話が無音の後に始まってから遅れて届くと、次の段落に入る

### 確認

1. `pnpm test`、`pnpm typecheck`、`pnpm build`
2. `pnpm build:harness` で検証用ページ（`src/dev/harness.ts`）をビルドし、`dev/overlap.json` の場面を Session に流す。タブ音声を取り込むにはアイコンのクリックが要るので、音声ファイルを AudioContext から同じ認識器・Arbiter・Paragrapher・翻訳に流す。拡張のページ（`chrome-extension://…/dev/harness.html`）として開くか、`dist` を配信して Web ページとして開く（`?engine=chrome`。PLaMo のモデルは拡張の OPFS にあるため）
3. 既存の `dev/player.html`（19発話、日英交互）で、二重表示・欠けが増えていないこと
4. 実際の会議でもう一度使い、ログから既定値を見直す

### 検証結果（2026-11-25、Chrome 157、検証用ページを Web ページとして、Chrome 翻訳で）

`dev/overlap.json` の11場面を1回ずつ流した。

- `monologue-en`（1人の英語、間 0.8〜1.8 秒の5断片）: 1段落。断片が足されるたびに訳し直し、最後の訳は1文になった
  - 初めから縮める閾値では、4回中1回、最後の断片が別の段落に分かれた（1.8 秒の間が 2117ms と測られ、閾値 2050ms を超えた）。単独の訳は「価格または合計金額である場合」
  - 上限の半分までは縮めない閾値に変えた後は、3回とも1段落
- `monologue-ja`: 1段落。ただし「クライアント側のUIと」が消えた（下の既知の不具合）
- `turn-gap`（3 秒空けて別の声）: 2段落（`closed: gap`）。閾値を変える前に2回、変えた後に3回流して、すべて同じ
- `turn-nogap`（0.3 秒で別の声）、`okay-inside`: Chrome 自身が1つの FINAL にまとめ、1段落
- 日英が重なる既存の場面（`ja-en`、`en-ja`、`same-start`、`ja-ja`、`backchannel-*`）: `docs/plans/2026-11-20-mvp.md` の「Task 3.5 の結果」の Arbiter 変更後と同じ（日英の重なりは両方採用、「Sure」「決済フロー」の欠け、相づちと同時の話し始めは片方だけ、日本語どうしは混ざった1文）。言語が替わるので段落は1発話ずつ
- Chrome 翻訳の訳し直しは1回 4〜65ms

入れた間と、測った無音（`silence …ms`。`paragraphMinGapMs` 未満は記録されないので、0.8 秒の間は出なかった回がある）:

| 入れた間 | 測った無音 |
|---|---|
| 0.8 秒 | 1200ms、1200ms、1201ms、1259ms |
| 1.2 秒 | 1179ms、1440ms、1557ms、1584ms、1616ms、1616ms、1680ms、1744ms |
| 1.5 秒 | 1499ms、1621ms、1735ms、1738ms、1739ms、1739ms、1771ms、1797ms |
| 1.8 秒 | 1856ms、1984ms、2037ms、2043ms、2043ms、2043ms、2043ms、2117ms |
| 3.0 秒 | 3499ms、3499ms、3558ms、3558ms、3559ms |

測った無音は、本当の無音とほぼ同じか、最大 0.56 秒長く出る。3 秒の話者交代は 3499〜3559ms と測られ、`paragraphMaxGapMs`（3000）で分かれる。2.5 秒を超える言いよどみと、間が 2.5 秒前後の話者交代の扱いは、会議のログで確かめる。

### 既知の不具合（段落とは別、未対応）

STALL の後に来た本物の FINAL が、確定済みの頭の後に続きを持つと、その続きが消える。StallFinalizer は続きを途中経過として持つ（`onRealFinal`）が、Chrome が FINAL の直後に送る空の途中経過で上書きされる。`monologue-ja` の「クライアント側のUIと」と、会議のログの `I priority QH gets` がこれで消えた。既存のテストは空の途中経過を再現していない。

---

## 段階2: STALL の言い直しを置き換える（段階1の後、別 PR）

次の条件をすべて満たすときだけ、段落の最後の断片を新しい判定で置き換える。どれかが外れたら段階1どおり足す。

1. 同じ段落に足す条件（同じ言語、区切りなし）を満たす。上限は見ない
2. 最後の断片が STALL 由来（`Decision` に `synthetic` を足す。その言語の Final がすべて STALL 由来なら true）
3. 最後の断片が十分に長い: en 5語以上、ja 8文字以上。短い文どうしは偶然の一致で似て見える（`I realized that` と `I think that` は3語中2語、`そうですね` と `そうですか` は5文字中4文字）
4. 時間が近い: 新しい判定の `firstAt` − 最後の断片の `firstAt` ≤ `stallMs` + 1000
5. 似ている: 最後の断片の語（ja は文字）のうち、新しい判定の先頭「最後の断片の長さ + 3」語の中に順序どおり現れる割合が 0.7 以上
   - 分母を最後の断片にするのは、直った FINAL が STALL の先まで続く場合も拾うため（長い方で割ると STALL 5語・FINAL 20語で 0.25）
   - ログの例: STALL 22語、FINAL の先頭25語の中に19語が順に現れる → 0.86

置き換えたら `paragraph #${key} revise "${old}" -> "${new}" sim=${score}` をログに出す。
