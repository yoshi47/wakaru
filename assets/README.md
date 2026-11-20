# assets

アイコンの元データ。`public/icons/` の PNG はここから生成する。

- `icon.svg`: 48px・128px 用（「A」と「あ」の吹き出し）
- `icon-small.svg`: 16px・32px 用（文字を抜き、吹き出しを大きくしたもの）

```sh
for s in 48 128; do rsvg-convert -w $s -h $s assets/icon.svg -o public/icons/icon-$s.png; done
for s in 16 32; do rsvg-convert -w $s -h $s assets/icon-small.svg -o public/icons/icon-$s.png; done
```
