# assets

アイコンの元データ。`public/icons/` の PNG はここから生成する。

- `icon.svg`: 48px・128px 用（「A」と「あ」の吹き出し）
- `icon-small.svg`: 16px・32px 用（文字を抜き、吹き出しを大きくしたもの）

色はサイドパネルのトークン（`src/sidepanel/style.css` のライト側）に合わせている。地は `--accent`（開始ボタンの緑）、「あ」の吹き出しは `--ja`（字幕で日本語を示す琥珀色）、「A」は `--en-ink`、白は `--bg`。トークンを変えたら、ここも合わせて作り直す。

```sh
for s in 48 128; do rsvg-convert -w $s -h $s assets/icon.svg -o public/icons/icon-$s.png; done
for s in 16 32; do rsvg-convert -w $s -h $s assets/icon-small.svg -o public/icons/icon-$s.png; done
```
