# Privacy

DiffScout has no server and collects no data.

- **What it reads:** when you Cmd/Ctrl+click in a GitHub pull request, it fetches that PR's metadata, changed files and repository files from `api.github.com` and `raw.githubusercontent.com`. Nothing else.
- **Your token:** if you add a GitHub token, it is kept in `chrome.storage.local` in your browser profile and sent only to `api.github.com` as an `Authorization` header. It is not synced or sent anywhere else.
- **No analytics, no tracking, no third parties.** Responses are cached in memory for a few minutes and discarded when the tab closes.
