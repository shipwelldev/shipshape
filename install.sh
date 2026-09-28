#!/bin/sh
# Install Ship Shape on Linux or macOS:
#
#   curl -fsSL https://shipshape.shipwell.dev/install | sh
#
# Environment:
#   SHIPSHAPE_VERSION         version to install, e.g. 0.1.0 (default: latest release)
#   SHIPSHAPE_INSTALL_DIR     where to put the binary (default: ~/.local/bin)
#   SHIPSHAPE_NO_MODIFY_PATH  set to 1 to leave shell startup files alone
#   SHIPSHAPE_RELEASES_URL    release location (default: GitHub releases)
#
# Everything runs inside main(), called on the last line, so a partially downloaded
# script does nothing.
set -eu

main() {
	releases=${SHIPSHAPE_RELEASES_URL:-https://github.com/shipwelldev/shipshape/releases}
	releases=${releases%/}
	install_dir=${SHIPSHAPE_INSTALL_DIR:-$HOME/.local/bin}

	target=$(detect_target)
	asset="shipshape-$target.tar.gz"
	if [ -n "${SHIPSHAPE_VERSION:-}" ]; then
		want=${SHIPSHAPE_VERSION#v}
		base="$releases/download/v$want"
	else
		want=""
		base="$releases/latest/download"
	fi

	tmp=$(mktemp -d)
	trap 'rm -rf "$tmp"' EXIT INT TERM

	say "Downloading $asset${want:+ ($want)}"
	download "$base/$asset" "$tmp/$asset"
	download "$base/SHA256SUMS" "$tmp/SHA256SUMS"
	expected=$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "$tmp/SHA256SUMS")
	[ -n "$expected" ] || fail "SHA256SUMS has no entry for $asset."
	actual=$(sha256 "$tmp/$asset")
	[ "$actual" = "$expected" ] || fail "Checksum mismatch for $asset; nothing was installed."

	tar -xzf "$tmp/$asset" -C "$tmp"
	[ -f "$tmp/shipshape" ] || fail "$asset does not contain shipshape."
	chmod 755 "$tmp/shipshape"
	version=$("$tmp/shipshape" --version) || fail "The downloaded binary does not run on this system; nothing was installed."
	case "$version" in
		[0-9]*.[0-9]*.[0-9]*) ;;
		*) fail "The downloaded binary did not report a version; nothing was installed." ;;
	esac
	if [ -n "$want" ] && [ "$version" != "$want" ]; then
		fail "The downloaded binary reports $version, expected $want."
	fi

	# Stage beside the destination, then rename, so a running shipshape is never overwritten mid-file.
	staged="$install_dir/.shipshape.install.$$"
	mkdir -p "$install_dir" || fail "Could not create $install_dir."
	if ! { cp "$tmp/shipshape" "$staged" && chmod 755 "$staged" && mv -f "$staged" "$install_dir/shipshape"; }; then
		rm -f "$staged"
		fail "Could not write to $install_dir; the existing install, if any, was not changed."
	fi
	say "Installed shipshape $version to $install_dir/shipshape"

	ensure_on_path "$install_dir"
	found=$(command -v shipshape 2>/dev/null || true)
	if [ -n "$found" ] && [ "$found" != "$install_dir/shipshape" ]; then
		say "Note: $found comes first on your PATH and will run instead of $install_dir/shipshape."
	fi
}

detect_target() {
	os=$(uname -s)
	arch=$(uname -m)
	case "$os" in
		Linux) os=linux ;;
		Darwin) os=darwin ;;
		MINGW* | MSYS* | CYGWIN*) fail "On Windows, install with PowerShell: powershell -ExecutionPolicy ByPass -c \"irm https://shipshape.shipwell.dev/install.ps1 | iex\"" ;;
		*) fail "Unsupported operating system: $os." ;;
	esac
	case "$arch" in
		x86_64 | amd64) arch=x64 ;;
		aarch64 | arm64) arch=arm64 ;;
		*) fail "Unsupported CPU architecture: $arch." ;;
	esac
	if [ "$os" = darwin ] && [ "$arch" = x64 ]; then
		# A shell running under Rosetta reports x86_64 on Apple silicon.
		if [ "$(sysctl -in sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
			arch=arm64
		else
			fail "Intel Macs are not supported yet; Ship Shape currently ships for Apple silicon."
		fi
	fi
	if [ "$os" = linux ] && [ -f /etc/alpine-release ]; then
		fail "musl-based Linux (such as Alpine) is not supported yet."
	fi
	echo "$os-$arch"
}

# Put the install directory on PATH through the startup file of the user's shell.
ensure_on_path() {
	dir=$1
	case ":$PATH:" in
		*":$dir:"*) return 0 ;;
	esac
	if [ "${SHIPSHAPE_NO_MODIFY_PATH:-}" = 1 ]; then
		say "Add $dir to your PATH to run shipshape."
		return 0
	fi
	case "$dir" in
		"$HOME"/*) shown="\$HOME${dir#"$HOME"}" ;;
		*) shown=$dir ;;
	esac
	case "$(basename "${SHELL:-sh}")" in
		zsh)
			rc="${ZDOTDIR:-$HOME}/.zshrc"
			line="case \":\$PATH:\" in *\":$shown:\"*) ;; *) export PATH=\"$shown:\$PATH\" ;; esac"
			;;
		bash)
			# macOS terminals start login shells, which read .bash_profile rather than .bashrc.
			if [ "$(uname -s)" = Darwin ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi
			line="case \":\$PATH:\" in *\":$shown:\"*) ;; *) export PATH=\"$shown:\$PATH\" ;; esac"
			;;
		fish)
			rc="${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/shipshape.fish"
			line="fish_add_path \"$shown\""
			;;
		*)
			rc="$HOME/.profile"
			line="case \":\$PATH:\" in *\":$shown:\"*) ;; *) export PATH=\"$shown:\$PATH\" ;; esac"
			;;
	esac
	if [ -f "$rc" ] && grep -qF "$line" "$rc"; then
		say "$rc already adds $dir to PATH; open a new terminal to run shipshape."
		return 0
	fi
	mkdir -p "$(dirname "$rc")"
	printf '\n# Added by the Ship Shape installer\n%s\n' "$line" >>"$rc"
	say "Added $dir to PATH in $rc. Open a new terminal, or run: export PATH=\"$dir:\$PATH\""
}

download() {
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL -o "$2" "$1" || fail "Download failed: $1"
	elif command -v wget >/dev/null 2>&1; then
		wget -qO "$2" "$1" || fail "Download failed: $1"
	else
		fail "Install curl or wget first."
	fi
}

sha256() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | awk '{ print $1 }'
	elif command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$1" | awk '{ print $1 }'
	else
		fail "Install sha256sum or shasum to verify the download."
	fi
}

say() {
	printf 'shipshape: %s\n' "$1"
}

fail() {
	printf 'shipshape: %s\n' "$1" >&2
	exit 1
}

main "$@"
