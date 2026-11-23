# Security

## Reporting

Use this repository's **Security → Report a vulnerability** flow (GitHub
private security advisories). Do not open a public issue with exploit details,
secrets, wallet addresses, or user data.

## Secrets

Never commit private keys, seed phrases, session tokens, API keys, passwords,
or exported browser profiles. Public wallet addresses are still personal data:
do not add a maintainer or user address to this source tree.

## Web shell

- Only HTTPS origins are accepted for site navigation.
- The wallet bridge is injected only into explicitly allowed origins.
- Cloud profile data is end-to-end encrypted before upload.
- The app never stores wallet private keys or seed phrases.

## Third-party code

See `THIRD_PARTY_NOTICES.md`. Prebuilt bundles remain subject to their upstream
licenses.
