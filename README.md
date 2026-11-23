# DeWEB Desktop Web

Static Web shell source for the DeWEB on-chain desktop, used by the Android
shell and compatible WebView hosts.

## Contents

```text
web/index.html              Web UI source
web/cloud-membership.js     cloud-sync UI client
web/tape-direct-src.js      TapeRelay client source
web/tape-direct.bundle.js   generated browser bundle
web/_headers                static-host headers
scripts/build-onchain.mjs   single-file inlining build
docs/screenshots/           placeholders; replace with sanitized captures
```

Electron, the old Supabase client, and platform-specific wrappers are not part
of this source tree.

## Build

```bash
node scripts/build-onchain.mjs --upload-copy --out out.html
```

The Android shell and Web host are separate projects.

## License

MIT. See `LICENSE` and `THIRD_PARTY_NOTICES.md`.
