# Privacy

DiffScout has no server and collects no data.

- **What it reads:** when you Cmd/Ctrl+click in a GitHub pull request, it fetches that PR's metadata, changed files and repository files from `api.github.com` and `raw.githubusercontent.com`. Nothing else.
- **Signing in:** "Sign in with GitHub" uses GitHub's device sign-in on `github.com/login`. The resulting token, and your GitHub username, are kept in `chrome.storage.local` in your browser profile. A personal access token you paste instead is stored the same way.
- **Where the token goes:** only to `api.github.com`, as an `Authorization` header. It is not synced or sent anywhere else. Signing out deletes it from the browser; you can also revoke it in your GitHub settings under Applications.
- **No analytics, no tracking, no third parties.** Responses are cached in memory for a few minutes and discarded when the tab closes.
