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

### Sign in (recommended)

The options page opens when you install DiffScout. Click **Sign in with GitHub**, enter the code it shows on the GitHub page that opens, and click **Authorize**. You can open the page again from `chrome://extensions` → DiffScout → **Details → Extension options**.

- Signing in lets DiffScout read private repositories and raises GitHub's rate limit. Public repositories work without it, but code search (step 7 below) is skipped.
- GitHub only offers full `repo` access to apps that read private code, so the sign-in asks for that. DiffScout only reads.
- If your organization restricts third-party apps, request approval when you authorize, or ask an org owner. If it uses SAML single sign-on, authorize DiffScout for it; DiffScout shows a button for this when it's needed.
- **Prefer a token?** Expand **Use a personal access token instead** in the options and paste a fine-grained token with read-only *Contents* and *Pull requests* access.

The token stays in your browser; see [PRIVACY.md](PRIVACY.md).

## How it works (language-agnostic)

No per-language plugins: the extension reads the PR through the GitHub API and uses text heuristics that cover the common definition shapes (`class/interface/struct/trait/enum X`, `def/fn/func/function X`, `const X =`, `Type name(...) {`, and so on). Lookup order:

1. A definition in the PR's changed lines. For `obj.method`, it prefers the file named after `obj`'s type.
2. The receiver's type file anywhere in the repo, e.g. `petValidator.validate` → `PetValidator.java`. The type comes from declarations like `PetValidator v`, `v: PetValidator` or `v = PetValidator(...)`, or failing that from the receiver's own name.
3. Elsewhere in the clicked file.
4. The module the clicked file imports the symbol from: Java/Kotlin packages, Python absolute and relative imports, JS/TS relative and aliased paths, Rust `use`.
5. Other files the PR touches, including the parts outside the hunks.
6. A file named after the symbol (`Invoice.java`, `invoice.py`, `Invoice/index.tsx`, `invoice.rs`), preferring the same language family.
7. GitHub code search (sign-in required), then the GitHub symbol-search page.

It is a heuristic, not a language server: overloads and dynamic dispatch can land on the wrong candidate, and only github.com is supported (not GitHub Enterprise Server).

## Contributing

Wrong jumps are the most useful bug reports. Please include a public PR link if you can. See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev setup and tests.

## License

[MIT](LICENSE)
