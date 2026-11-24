#!/usr/bin/env bash
# Checks which files from a CI run's browser-tests artifact reach the reviewer (ADR-0066): only
# plainly named PNGs at screenshots/<project>/, capped in number and size.
# Run from anywhere: .github/factory/test-load-screenshots.sh
# shellcheck source=.github/factory/testlib.sh
. "$(dirname "$0")/testlib.sh"

art="$work/artifact"
mkdir -p "$art/screenshots/desktop" "$art/screenshots/phone/deeper" "$art/screenshots/odd project" "$art/report/data"
printf png >"$art/screenshots/desktop/sign-in-light.png"
printf png >"$art/screenshots/phone/sign-in-dark.png"
printf png >"$art/screenshots/phone/deeper/nested.png"
printf png >"$art/screenshots/phone/has space.png"
printf png >"$art/screenshots/phone/..png"
printf txt >"$art/screenshots/phone/notes.txt"
printf png >"$art/screenshots/odd project/a.png"
printf png >"$art/screenshots/loose.png"
printf html >"$art/report/index.html"
printf png >"$art/report/data/abc.png"
ln -s /etc/passwd "$art/screenshots/desktop/link.png"
head -c 2000 /dev/zero >"$art/screenshots/desktop/huge.png"

out=$(MAX_BYTES=1000 "$here/load-screenshots.sh" "$art" "$work/dest" 2>&1)
got=$(cd "$work/dest" && find . -print | sort | tr '\n' ' ')
expect "copies only plain PNGs at screenshots/<project>/" ". ./desktop ./desktop/sign-in-light.png ./phone ./phone/sign-in-dark.png " "$got"
expect_in "counts what it copied" "$out" "2 screenshots."
expect_in "warns about what it skipped" "$out" "::warning::Skipped"

out=$(MAX_FILES=1 "$here/load-screenshots.sh" "$art" "$work/capped" 2>&1)
expect "stops at the file cap" 1 "$(find "$work/capped" -name '*.png' | wc -l | tr -d ' ')"
expect_in "warns at the cap" "$out" "::warning::"

mkdir -p "$work/empty"
status=0
out=$("$here/load-screenshots.sh" "$work/empty" "$work/none" 2>&1) || status=$?
expect "no screenshots doesn't fail the review" 0 "$status"
[ -d "$work/none" ] || fail "makes the destination even when there's nothing to copy"
expect_in "says there were none" "$out" "No screenshots"

finish "All screenshot loading checks passed"
