#!/usr/bin/env bash
#
# Clone every repo in fixtures/manifest.toml into fixtures/repos/<name> at its
# pinned SHA. fixtures/repos/ is gitignored; nothing here is redistributed.
#
# Idempotent:
#   - repo absent            -> fetch the pinned SHA and check it out
#   - repo present, on SHA   -> skip
#   - repo present, off SHA  -> fetch the SHA, hard-reset, clean
#
# No submodules are initialised. Offline or unreachable repos are reported
# clearly and counted; the script exits non-zero if any fixture failed.
#
# Usage:
#   scripts/fetch-fixtures.sh [name ...]
# With no arguments, processes every fixture. With names, only those.

set -u -o pipefail

# conman analyses the text tree, not binaries. Skip Git LFS smudge so fixtures
# with LFS-tracked assets (and possibly an exhausted LFS budget, e.g. lila)
# still check out. Harmless for repos that do not use LFS.
export GIT_LFS_SKIP_SMUDGE=1

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
manifest="$repo_root/fixtures/manifest.toml"
dest_root="$repo_root/fixtures/repos"

if [ ! -f "$manifest" ]; then
	echo "error: manifest not found at $manifest" >&2
	exit 2
fi

mkdir -p "$dest_root"

# --- parse the manifest -----------------------------------------------------
# Only the flat `key = "value"` lines matter here (name/url/sha/branch). The
# notes = """ ... """ blocks and entry_points arrays are ignored. Emits one
# tab-separated record per fixture: name<TAB>url<TAB>sha<TAB>branch
parse_manifest() {
	awk '
		/^\[\[fixture\]\]/ {
			if (have) print name "\t" url "\t" sha "\t" branch
			name = url = sha = branch = ""; have = 1; next
		}
		{
			line = $0
			sub(/^[ \t]+/, "", line)
		}
		line ~ /^name[ \t]*=/    { name   = val(line) }
		line ~ /^url[ \t]*=/     { url    = val(line) }
		line ~ /^sha[ \t]*=/     { sha    = val(line) }
		line ~ /^branch[ \t]*=/  { branch = val(line) }
		END { if (have) print name "\t" url "\t" sha "\t" branch }
		function val(s,   v) {
			sub(/^[^=]*=[ \t]*/, "", s)
			v = s
			sub(/^"/, "", v); sub(/"[ \t]*$/, "", v)
			return v
		}
	' "$manifest"
}

# --- offline check --------------------------------------------------------
online_hint() {
	cat >&2 <<-EOF
	  This looks like a network problem. fetch-fixtures.sh needs outbound HTTPS
	  to github.com. If you are offline, re-run it once you have a connection;
	  already-fetched fixtures under fixtures/repos/ are left untouched.
	EOF
}

# --- fetch one pinned SHA into an existing git dir ------------------------
# $1 = git dir, $2 = sha, $3 = branch. Tries cheap depth-1 by SHA first, then
# widening fallbacks for servers that will not serve an arbitrary SHA directly.
fetch_sha() {
	local dir=$1 sha=$2 branch=$3
	if git -C "$dir" cat-file -e "${sha}^{commit}" 2>/dev/null; then
		return 0
	fi
	git -C "$dir" fetch --quiet --depth 1 origin "$sha" 2>/dev/null && return 0
	git -C "$dir" fetch --quiet --depth 1 origin "$branch" 2>/dev/null || true
	git -C "$dir" cat-file -e "${sha}^{commit}" 2>/dev/null && return 0
	git -C "$dir" fetch --quiet --deepen 200 origin "$branch" 2>/dev/null || true
	git -C "$dir" cat-file -e "${sha}^{commit}" 2>/dev/null && return 0
	# last resort: full history for that branch
	git -C "$dir" fetch --quiet --unshallow origin "$branch" 2>/dev/null || \
		git -C "$dir" fetch --quiet origin "$branch" 2>/dev/null || true
	git -C "$dir" cat-file -e "${sha}^{commit}" 2>/dev/null
}

process_one() {
	local name=$1 url=$2 sha=$3 branch=$4
	local dir="$dest_root/$name"

	if [ -z "$name" ] || [ -z "$url" ] || [ -z "$sha" ]; then
		echo "SKIP  (incomplete manifest entry: name='$name' url='$url' sha='$sha')" >&2
		return 1
	fi

	if [ -d "$dir/.git" ]; then
		local cur
		cur=$(git -C "$dir" rev-parse HEAD 2>/dev/null || echo none)
		if [ "$cur" = "$sha" ]; then
			echo "skip  $name            already at $sha"
			return 0
		fi
		echo "reset $name            $cur -> $sha"
		if ! fetch_sha "$dir" "$sha" "$branch"; then
			echo "FAIL  $name            could not fetch $sha" >&2
			online_hint
			return 1
		fi
		git -C "$dir" reset --quiet --hard "$sha" && git -C "$dir" clean -qfdx
		return $?
	fi

	echo "clone $name            $url @ $sha"
	rm -rf "$dir"
	git init --quiet "$dir" || { echo "FAIL  $name            git init failed" >&2; return 1; }
	git -C "$dir" remote add origin "$url"
	if ! fetch_sha "$dir" "$sha" "$branch"; then
		echo "FAIL  $name            could not fetch $sha from $url" >&2
		online_hint
		rm -rf "$dir"
		return 1
	fi
	git -C "$dir" checkout --quiet --detach "$sha" || {
		echo "FAIL  $name            checkout of $sha failed" >&2
		return 1
	}
}

# --- main ----------------------------------------------------------------
want=("$@")
in_want() {
	[ ${#want[@]} -eq 0 ] && return 0
	local n
	for n in "${want[@]}"; do [ "$n" = "$1" ] && return 0; done
	return 1
}

total=0 ok=0 failed=0
while IFS=$'\t' read -r name url sha branch; do
	[ -z "$name" ] && continue
	in_want "$name" || continue
	total=$((total + 1))
	if process_one "$name" "$url" "$sha" "$branch"; then
		ok=$((ok + 1))
	else
		failed=$((failed + 1))
	fi
done < <(parse_manifest)

echo
echo "fixtures: $ok ok, $failed failed, $total processed  (dest: $dest_root)"
[ "$failed" -eq 0 ]
