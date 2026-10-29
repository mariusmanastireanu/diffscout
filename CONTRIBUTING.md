# Contributing

Bug reports with a public PR link are the most useful thing you can send: use the **Wrong or missing jump** issue template.

## Development

1. `chrome://extensions` → **Developer mode** → **Load unpacked** → this folder.
2. After a change, click the reload icon on the extension card and refresh the PR tab.

Code layout:

- `src/resolver.js`: pure, language-agnostic heuristics (definition patterns, import hints, path ranking). Most fixes go here.
- `src/content.js`: click handling, GitHub API calls through the background worker, scrolling and navigation.
- `src/background.js`: the only place that talks to the network.

## Tests

```bash
npm test
```

```bash
GITHUB_TOKEN=$(gh auth token) npm run test:e2e
```

A resolver fix should come with a case in `test/resolver.test.js`, and ideally a live PR case in `test/e2e.mjs`. No runtime dependencies, please: the extension ships as plain files.
