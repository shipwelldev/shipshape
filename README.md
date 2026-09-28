# Ship Shape

One-shot code review from the command line. Ship Shape resolves what to review, runs a fresh
[Pi](https://github.com/earendil-works/pi) agent session with read-only tools, requires a
structured report, validates every finding's location, applies your failure policy, and exits
with a verdict. It is built for three callers: people in a terminal, coding agents running
shell commands, and CI.

Status: pre-release. See [What is not in this version](#what-is-not-in-this-version).

## Install

Linux and macOS (Apple silicon):

```sh
curl -fsSL https://shipshape.shipwell.dev/install | sh
```

Windows (x64, or Arm through emulation), from PowerShell or Command Prompt:

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://shipshape.shipwell.dev/install.ps1 | iex"
```

Then check it:

```sh
shipshape --version
```

Both scripts download a standalone binary from the latest GitHub release (no Node.js needed),
verify its SHA-256 checksum, and check that it runs before installing it.

- `install.sh` installs to `~/.local/bin`. If that directory isn't on your PATH, it adds it in
  your shell's startup file (`.bashrc`, `.bash_profile` on macOS, `.zshrc`, fish `conf.d`, or `.profile`),
  so open a new terminal afterwards.
- `install.ps1` installs to `%LOCALAPPDATA%\Programs\shipshape` and adds it to your user PATH,
  so open a new terminal afterwards.

Git is needed to review changes; `--all` also works on a plain directory.

### Install options

The scripts read these environment variables:

| Variable | Effect |
| --- | --- |
| `SHIPSHAPE_VERSION` | Install a specific version, such as `0.1.0` (default: the latest release) |
| `SHIPSHAPE_INSTALL_DIR` | Install somewhere else |
| `SHIPSHAPE_NO_MODIFY_PATH=1` | Don't change PATH or shell startup files |
| `SHIPSHAPE_RELEASES_URL` | Download from a mirror instead of GitHub releases |

With `curl`, put the variable on `sh`, the command that runs the script:

```sh
curl -fsSL https://shipshape.shipwell.dev/install | SHIPSHAPE_VERSION=0.1.0 sh
curl -fsSL https://shipshape.shipwell.dev/install | sudo env SHIPSHAPE_INSTALL_DIR=/usr/local/bin sh
```

In PowerShell, set it first:

```powershell
$env:SHIPSHAPE_VERSION = "0.1.0"
powershell -ExecutionPolicy ByPass -c "irm https://shipshape.shipwell.dev/install.ps1 | iex"
```

Every release also carries its own copies of the scripts. The links above always serve the
latest release's scripts, and pre-releases are never "latest", so install a pre-release with
the script from its tag:

```sh
curl -fsSL https://github.com/shipwelldev/shipshape/releases/download/v<version>/install.sh | SHIPSHAPE_VERSION=<version> sh
```

### Upgrade

```sh
shipshape update          # install the latest release in place
shipshape update --check  # only report whether a newer release exists
```

`shipshape update` downloads the latest GitHub release for your platform. It verifies the
download's SHA-256 checksum and that the new binary runs and reports the expected version, and
only then replaces the installed binary. If it fails, the installed version is left as it was.
`--check` exits 0 when up to date, 1 when an update is available, and 2 on error, so scripts
can use it. If the binary is in a directory you can't write to (for example after a `sudo`
install), run `sudo shipshape update`.

Running the install script again also upgrades, and with `SHIPSHAPE_VERSION` it installs any
specific version, including an older one. A copy run from source cannot update itself.

### Uninstall

Linux and macOS: delete `~/.local/bin/shipshape` and the lines marked
`# Added by the Ship Shape installer` in your shell startup file.

Windows: delete `%LOCALAPPDATA%\Programs\shipshape` and remove that folder from your user
`Path` (search the Start menu for "Edit environment variables for your account").

To remove everything, also delete the configuration and stored credentials, and the cache
(which holds any search tools downloaded for reviews):

| | Configuration | Cache |
| --- | --- | --- |
| Linux | `~/.config/shipshape` | `~/.cache/shipshape` |
| macOS | `~/Library/Application Support/shipshape` | `~/Library/Caches/shipshape` |
| Windows | `%APPDATA%\shipshape` | `%LOCALAPPDATA%\shipshape` |

## Quick start

```sh
export ANTHROPIC_API_KEY=...            # or: shipshape login anthropic
shipshape config set model anthropic/<model-id> --global
shipshape review
```

To run from source instead (Node.js 22.19 or newer):

```sh
npm install
npm run build
npm link            # puts `shipshape` on your PATH; or run: node dist/cli/main.js
```

## Review targets

| Command | Reviews |
| --- | --- |
| `shipshape review` | Uncommitted changes against `HEAD`: staged, unstaged, and untracked (not ignored) files |
| `shipshape review --staged` | Only the staged index. The reviewer sees a private snapshot of the index, never unstaged edits |
| `shipshape review --base main` | Commits on `HEAD` since its merge base with `main` (the PR diff), in a private snapshot of `HEAD` |
| `shipshape review --base BASE --head HEAD_SHA` | The same, for explicit revisions (CI) |
| `shipshape review --all` | The entire codebase. Also works on a directory outside Git, honoring its `.gitignore` files |

An empty target produces `no_changes` (exit 0); it never falls back to a full-codebase review.
The model and credentials are checked first, even when there turns out to be nothing to review,
so a misconfigured CI gate fails (exit 2) instead of passing on an empty diff.
`-C DIR` reviews the repository at `DIR`. Snapshots are made with a temporary index, so your
index and working tree are never modified.

For the working tree, Ship Shape records a content hash and checks it again at the end. If the
files changed during the review, the result is `incomplete` (`target_changed`).

## Output and exit status

`--format text` (default) prints a readable report on stdout and progress on stderr.
`--format json` prints one JSON document on stdout, with no color or control codes.

| Status | Exit | Meaning |
| --- | --- | --- |
| `passed` | 0 | Complete review; no finding at or above `fail_on` |
| `no_changes` | 0 | Nothing in scope to review |
| `failed` | 1 | Complete review with at least one blocking finding |
| `incomplete` | 2 | The review ran but did not yield a trustworthy complete result (timeout, provider error, missing or invalid report, target changed) |
| `error` | 2 | The review could not run (configuration, target, model, or credentials) |
| `cancelled` | 130 / 143 | Interrupted by SIGINT / SIGTERM; never a pass |

Pass or fail is derived by Ship Shape from validated findings and `fail_on`. The model never
supplies a verdict. If a report was submitted but the run later failed, timed out, or was
cancelled, the completion is discarded; findings are still shown as partial results.

The JSON document (`schema_version: 1`) contains:

- `status`, `exit_code`, and `problem` (`reason` and `message`, present on incomplete, error, and cancelled).
- `target`: kind, description, identity (base, merge base, and head commits; `content_sha256` for uncommitted content), changed files, and excluded paths.
- `model`, `policy.fail_on`, and the reviewer's `summary`.
- `findings`, each with `id`, `severity` (critical, high, medium, low), `category` (bug, security, standards, other), `title`, `description`, `path`, `line_start`/`line_end`, `side` (`new` or `old`), `trigger`, `impact`, `evidence`, `standard`, `suggestion`, `in_diff`, and `blocking`.
- `counts`; `coverage` (diffs omitted from the prompt, files the reviewer actually read, and limitations); `usage` (tokens, plus cost when reported). Cost is left out for subscription sign-ins, where list prices are not what you pay.

### For coding agents

```sh
shipshape review --format json --non-interactive
```

Read `status` and `exit_code`. Every finding has a validated `path` and 1-based line range in
the reviewed version, or `side: "old"` for deleted lines.

## How findings are validated

The reviewer must call a `submit_review` tool. Ship Shape checks each finding before accepting
the report:

- The file exists in the reviewed version, or in the base version for `side: "old"`.
- The line range is inside the file.
- The path is inside the workspace and not excluded.
- Bug and security findings state a trigger; standards findings cite the rule.

An invalid report is returned to the reviewer with the specific problems, up to two repair
attempts. After that, the valid findings are kept and the review is `incomplete`. If the
reviewer stops without submitting, it is asked once more; then the review is `incomplete`.

## Configuration

Precedence, evaluated separately for each setting: **CLI flag > project `.shipshape.toml` >
global config > built-in default**.

- **Project file:** `.shipshape.toml` at the Git root, or at the selected directory outside Git. `--config PATH` replaces it.
- **Global file:** `shipshape/config.toml` in the platform config directory (`$XDG_CONFIG_HOME` or `~/.config` on Linux, `~/Library/Application Support` on macOS, `%APPDATA%` on Windows).

Other rules:

- A missing setting inherits from the next layer. Lists replace; they are not merged, so `exclude = []` clears an inherited list.
- Relative paths resolve against the file that declares them. CLI paths resolve against the directory you ran the command from.
- Unknown keys and invalid values are errors, never silently ignored.

`shipshape config show --sources` prints each effective value with where it came from.

`shipshape config set KEY VALUE... --global|--project` and `shipshape config unset KEY
--global|--project` edit one file without disturbing its comments or layout. You must choose
the file; there is no default. Values are parsed by setting type. List settings take several
values, or `[]` for an empty list. The edited file is validated before it is written, and the
command tells you when another layer overrides the value you just set.

```sh
shipshape config set model anthropic/<model-id> --global
shipshape config set review.exclude "vendor/**" "*.lock" --project
shipshape config unset review.fail_on --project   # inherit again
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `model` | none (required) | Provider-qualified model, `provider/model-id` |
| `thinking` | `"medium"` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; clamped to what the model supports |
| `format` | `"text"` | `text` or `json` |
| `auth_file` | `<config dir>/shipshape/auth.json` | Credential file. Global config or `--auth-file` only |
| `review.fail_on` | `"high"` | Findings at or above this severity fail the review |
| `review.timeout_seconds` | `600` | Whole-review deadline; `0` disables it |
| `review.exclude` | `[]` | Globs matched against repository paths. A pattern without `/` matches file names at any depth; `dir/` matches everything under `dir` |
| `review.instructions` | `""` | Text appended to the built-in review instructions |
| `review.focus_file` | built-in | File that **replaces** the built-in "what to look for" section |
| `review.standards_files` | `["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md"]` | Repository files injected as documented standards (missing ones are skipped) |

Each setting has a matching flag: `--model`, `--thinking`, `--format`, `--auth-file`, `--fail-on`,
`--timeout`, `--exclude` (repeatable), `--instructions`, and `--focus-file`.

```toml
# .shipshape.toml
[review]
fail_on = "medium"
exclude = ["vendor/**", "*.lock"]
instructions = "This service handles payments; be strict about rounding and idempotency."
```

The default review covers bugs, security, and violations of the documented repository
standards. The severity definitions and the finding contract always come from Ship Shape, so
`focus_file` changes what is looked for, not how it is reported.

## Credentials

- **Environment variables** work everywhere and are the intended route for CI: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, and the other variables in [Pi's provider list](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/docs/providers.md).
- **Auth file** (`auth_file`, Pi's `auth.json` format). `shipshape login [provider]` stores an API key or runs the provider's OAuth sign-in; `shipshape logout [provider]` removes it. A stored credential takes precedence over the environment variable for the same provider.
- **Reusing Pi.** If you already use Pi, set `auth_file = "~/.pi/agent/auth.json"` in the global config. Ship Shape does not need Pi installed; its runtime is bundled.

`login` offers every OAuth flow Pi supports, including subscription sign-ins. Whether a given
provider's terms allow using a subscription this way has **not** been verified; that is between
you and the provider.

Custom OpenAI-, Anthropic-, or Google-compatible endpoints can be added in
`<config dir>/shipshape/models.json` ([Pi's format](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/docs/models.md)).

## Security model

- The reviewer gets Pi's `read`, `grep`, `find`, and `ls`, plus `submit_review`. No shell, edit, or write tools.
  Tool selection is **not** an OS sandbox: `read` can open any file the process can.
- Nothing is discovered from disk into the session: no Pi extensions, skills, prompt templates, context files, or Pi settings.
  Pi's state directory is redirected to `<cache dir>/shipshape/pi` (managed `rg`/`fd` downloads, if needed), so `~/.pi` is never read or written implicitly.
- Repository content, including standards files, is presented to the reviewer as material under review, not as instructions.
- A repository cannot choose credentials: `auth_file` is rejected in project config, because Pi's auth format can run `!command` keys.
  Standards files must really resolve inside the repository, even through symlinked directories, or they are skipped (and listed as a limitation).
  A discovered `.shipshape.toml` also cannot point `focus_file` outside the repository.
- **In CI, the code under review must not choose the policy that judges it.** Pass the threshold as a flag and select a trusted config with `--config`:

  ```sh
  shipshape review --base "$BASE_SHA" --head "$HEAD_SHA" --format json --non-interactive \
    --fail-on high --config /path/to/trusted/shipshape.toml
  ```

## What is not in this version

- GitHub Action, job summary, PR annotations, and required-check or merge-queue enforcement.
- `shipshape doctor`, third-party Pi provider extensions, and shell/test execution during review.
- A Homebrew tap, Scoop, or winget packages, and code signing for macOS and Windows binaries. There is no npm package.

## Development

```sh
npm test            # unit and end-to-end tests with a scripted fake model (no network)
npm run typecheck
npm run build
npm run build:binary   # release archive for this machine in release/ (needs Bun)
```

`scripts/build-binary.ts` builds `release/shipshape-<target>.tar.gz` (`.zip` on Windows),
containing the compiled binary and `LICENSE`. Options are `--target linux-x64|linux-arm64|darwin-arm64|windows-x64`
and `--version X.Y.Z` (default: `package.json`). Binaries start from `src/cli/binary.ts`, which
loads Pi's own Bun setup so OAuth sign-in and Amazon Bedrock work in a compiled build.

The end-to-end tests drive the real CLI and a real Pi session against Pi's `fauxProvider`.
They cover pass, fail, threshold, report repair, missing reports, provider errors, timeouts,
cancellation, target changes during a run, staged snapshots, and prompt contents.
The source is organized as `src/cli` (commands), `src/config` (layered settings), `src/target`
(Git targets and snapshots), `src/runtime` (Pi session setup), `src/review` (prompt, report
tool, run lifecycle, policy), and `src/report` (text and JSON).

## Releasing

1. Set `version` in `package.json` (for example `0.1.0`) and commit.
2. Tag the commit and push the tag: `git tag v0.1.0 && git push origin v0.1.0`.

`.github/workflows/release.yml` checks that the tag matches `package.json`, runs the typecheck
and tests, and builds and smoke-tests a binary on each platform's native runner. It then
publishes the release with the archives, `SHA256SUMS`, and both install scripts, and finally
installs the published release on every platform to confirm it works. A tag with a suffix
(`v0.1.0-rc.1`) becomes a GitHub pre-release. The install scripts' default (latest) and
`shipshape update` skip pre-releases, so a pre-release is a safe rehearsal.
