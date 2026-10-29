# DiffScout

[![CI](https://github.com/mariusmanastireanu/diffscout/actions/workflows/ci.yml/badge.svg)](https://github.com/mariusmanastireanu/diffscout/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Go to definition for GitHub pull requests. A Chrome extension: **Cmd+click** (Ctrl+click on Windows/Linux) a class, function, method or constant in a GitHub pull request diff to jump to its definition.

- Definition is inside the PR diff → scrolls there (browser Back returns you).
- Definition is elsewhere → opens the file at the PR's head commit, on the right line, in a new tab.
- Nothing found (e.g. a library symbol) → opens GitHub's symbol search for the repo.

Holding Cmd underlines the identifier under the cursor, as in an IDE.

## Install

From a release:

1. Download `diffscout-<version>.zip` from [Releases](https://github.com/mariusmanastireanu/diffscout/releases) and unzip it.
2. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick the unzipped folder.

From source: clone the repo and load the folder the same way.

### GitHub token (recommended)

Open the extension's **Details → Extension options**, paste a token, then click **Save** and **Test**.

- Fine-grained token: read-only **Contents** and **Pull requests** on the repos you review. Some orgs require an admin to approve it.
- Classic token: the `repo` scope. It needs no approval, but it also grants write access.
- If your org uses SAML SSO, authorize the token for the org.

Without a token, only public repos work, you are limited to GitHub's anonymous rate limit, and code search (step 7 below) is skipped. The token stays in your browser; see [PRIVACY.md](PRIVACY.md).

## How it works (language-agnostic)

No per-language plugins: the extension reads the PR through the GitHub API and uses text heuristics that cover the common definition shapes (`class/interface/struct/trait/enum X`, `def/fn/func/function X`, `const X =`, `Type name(...) {`, and so on). Lookup order:

1. A definition in the PR's changed lines. For `obj.method`, it prefers the file named after `obj`'s type.
2. The receiver's type file anywhere in the repo, e.g. `petValidator.validate` → `PetValidator.java`. The type comes from declarations like `PetValidator v`, `v: PetValidator` or `v = PetValidator(...)`, or failing that from the receiver's own name.
3. Elsewhere in the clicked file.
4. The module the clicked file imports the symbol from: Java/Kotlin packages, Python absolute and relative imports, JS/TS relative and aliased paths, Rust `use`.
5. Other files the PR touches, including the parts outside the hunks.
6. A file named after the symbol (`Invoice.java`, `invoice.py`, `Invoice/index.tsx`, `invoice.rs`), preferring the same language family.
7. GitHub code search (token required), then the GitHub symbol-search page.

It is a heuristic, not a language server: overloads and dynamic dispatch can land on the wrong candidate, and only github.com is supported (not GitHub Enterprise Server).

## Contributing

Wrong jumps are the most useful bug reports. Please include a public PR link if you can. See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev setup and tests.

## License

[MIT](LICENSE)
