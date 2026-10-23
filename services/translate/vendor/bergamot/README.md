# Bergamot JavaScript glue

`bergamot-translator.js` is the Emscripten glue Firefox uses to run its translation engine, copied unchanged from the Firefox source tree:

- source: `toolkit/components/translations/bergamot-translator/bergamot-translator.js` in https://github.com/mozilla-firefox/firefox (main, October 2026)
- built from https://github.com/mozilla/translations, release v0.6.0, revision `eea6e5a80aa4ddd86d9cc35ce9a65b79aa3ab96d`
- license: MPL-2.0 (`LICENSE-MPL-2.0.txt`)

The matching WebAssembly binary and the translation models are not in this repository. The Bergamot translation source downloads them on demand from Mozilla's Remote Settings (`translations-wasm` and `translations-models` collections), the same files Firefox downloads, and checks each file's SHA-256 against the record.
