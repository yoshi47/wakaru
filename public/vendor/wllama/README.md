# wllama

[wllama](https://github.com/ngxson/wllama)（MIT）は llama.cpp（MIT）を WebAssembly にしたもの。wakaru では PLaMo 3 Translate をサイドパネルの中で動かすのに使う。

npm 版（3.8.1）は PLaMo 3 のトークナイザより古い llama.cpp を同梱しているので使えない。代わりに tanakh/plamo-translate-desktop が自前でビルドしたものをそのまま置いている。

## 入手元

- リポジトリ: https://github.com/tanakh/plamo-translate-desktop
- コミット: `3d69a116c45a8116159f1a405311a59039ec4b95`
- パス: `extension/vendor/wllama/`
- 中身: wllama 3.12.0（`c10c21114984e37fe6ba4edbba446c28c5b7a954`）、llama.cpp（`d38bea34227bbf9069d62fdc239c98ab6e05435a`）、パッチ `cache-ram.patch`

## sha256

```
092ebfa92d944f7f259381e2972da0745bb7a0c37c96334859f420c4991a6703  wllama.js
7cfddc0ff54b5d5fb8b0efbd1bc209dd94e0d882dcf581aa9066f1659a873b1f  wllama.wasm
5866e3bd7e3cbd3f7c8bea6efd8a1e7fa7cc8de68c30f428aff7c6584a0fb720  LICENSE-wllama.txt
94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d  LICENSE-llama.cpp.txt
```

## 更新するとき

入手元のリポジトリで新しいコミットを選び、同じパスの 4 ファイルを置き換えて、このファイルのコミットと sha256 を書き直す。
