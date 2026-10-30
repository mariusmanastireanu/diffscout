# Contributing

Bug reports with a public PR link are the most useful thing you can send: use the **Wrong or missing jump** issue template.

## Development

1. `chrome://extensions` → **Developer mode** → **Load unpacked** → this folder.
2. After a change, click the reload icon on the extension card and refresh the PR tab.

Code layout:

- `src/resolver.js`: pure, language-agnostic heuristics (definition patterns, import hints, path ranking). Most fixes go here.
- `src/content.js`: click handling, GitHub API calls through the background worker, scrolling and navigation.
- `src/background.js`: the only place that talks to the network. Also runs "Sign in with GitHub" (OAuth device flow).
- `options.html` / `options.js`: sign in, sign out, or paste a personal access token.

## Tests

```bash
npm test
```

```bash
GITHUB_TOKEN=$(gh auth token) npm run test:e2e
```

`npm test` covers the resolver (`test/resolver.test.js`), sign-in and API error handling (`test/auth.test.js`), and the messages shown on the page (`test/content.test.js`). A resolver fix should come with a case in `test/resolver.test.js`, and ideally a live PR case in `test/e2e.mjs`. No runtime dependencies, please: the extension ships as plain files.

## Releasing

Run the **Release** workflow from the Actions tab and pick `patch`, `minor` or `major`. It bumps the version in `manifest.json` and `package.json`, commits and tags on `main`, and publishes a GitHub Release with the extension zip. Upload that zip to the Chrome Web Store.
