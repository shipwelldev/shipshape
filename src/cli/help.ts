const MAIN = `Ship Shape: one-shot code review on the command line.

Usage:
  shipshape review [target] [options]   Review changes and exit with a verdict
  shipshape config show [--sources]     Show the effective configuration
  shipshape config set KEY VALUE...     Set a value (--global or --project)
  shipshape config unset KEY            Remove a value (--global or --project)
  shipshape login [provider]            Store provider credentials
  shipshape logout [provider]           Remove stored provider credentials
  shipshape --version

Run "shipshape <command> --help" for details.`;

const REVIEW = `Usage: shipshape review [target] [options]

Targets (default: uncommitted changes, staged and unstaged, plus untracked files):
  --staged              Review only staged changes
  --base REF            Review changes on --head since its merge base with REF
  --head REF            Commit to review with --base (default: HEAD)
  --all                 Review the entire codebase (also works outside Git)

Options:
  --model PROVIDER/ID   Model to use, e.g. anthropic/<model-id>
  --thinking LEVEL      off, minimal, low, medium, high, xhigh, max
  --format FORMAT       text or json (json: machine-readable result on stdout)
  --fail-on SEVERITY    Fail on findings at or above critical, high, medium, low
  --timeout SECONDS     Whole-review deadline; 0 disables it
  --exclude GLOB        Exclude paths (repeatable; replaces configured excludes)
  --instructions TEXT   Extra review instructions appended to the built-in ones
  --focus-file PATH     Replace the built-in review focus with this file
  --auth-file PATH      Credential file (default: <config dir>/shipshape/auth.json)
  --config PATH         Use this file instead of the project's .shipshape.toml
  -C, --cwd DIR         Review the repository or directory at DIR
  --non-interactive     Never prompt
  -h, --help            Show this help

Exit status: 0 passed or no changes, 1 blocking findings, 2 incomplete or error,
130/143 cancelled.`;

const CONFIG = `Usage:
  shipshape config show [--sources] [options]
  shipshape config set KEY VALUE... (--global | --project) [options]
  shipshape config unset KEY (--global | --project) [options]

"show" prints the effective configuration after applying, highest first:
CLI flags, project .shipshape.toml (or --config), global config, built-in defaults.
Setting flags accepted by "shipshape review" (such as --model) are applied too.

"set" and "unset" edit one file, keeping its comments and layout. The result is
validated before it is written. Removing a key makes it inherit from the next layer.

  --global              Edit your user config (<config dir>/shipshape/config.toml)
  --project             Edit the project's .shipshape.toml (or the --config file)
  --sources             (show) Annotate each value with where it came from
  --config PATH         Use this file instead of the project's .shipshape.toml
  -C, --cwd DIR         Resolve the project from DIR

Keys: model, thinking, format, auth_file (global only), review.fail_on,
review.timeout_seconds, review.exclude, review.instructions, review.focus_file,
review.standards_files. List settings take several values, or [] for an empty
list. Paths are written as given and resolve relative to the edited file.

Examples:
  shipshape config set model anthropic/<model-id> --global
  shipshape config set review.exclude "vendor/**" "dist/**" --project
  shipshape config unset review.fail_on --project`;

const LOGIN = `Usage: shipshape login [provider] [--auth-file PATH]

Store an API key or sign in with OAuth for a provider. Credentials are saved to
the auth file (default: <config dir>/shipshape/auth.json, Pi's auth.json format).
Set auth_file in the global config to share an existing Pi auth.json.

In CI, set the provider's API key environment variable instead.`;

const LOGOUT = `Usage: shipshape logout [provider] [--auth-file PATH]

Remove a provider's stored credentials from the auth file. This does not unset
environment variables or revoke the credential with the provider.`;

const TOPICS: Record<string, string> = { review: REVIEW, config: CONFIG, login: LOGIN, logout: LOGOUT };

export function helpText(topic?: string): string {
	return `${(topic && TOPICS[topic]) || MAIN}\n`;
}
