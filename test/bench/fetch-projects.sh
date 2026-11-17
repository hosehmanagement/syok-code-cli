#!/usr/bin/env bash
# Downloads the real projects the accuracy measurement runs on, each at one fixed version, so the numbers can be compared
# from run to run. Usage: fetch-projects.sh <folder>
set -euo pipefail
dest="$1"; mkdir -p "$dest"
get() { # name, repository, exact version
  if [ -d "$dest/$1/.git" ]; then return; fi
  mkdir -p "$dest/$1"; git -C "$dest/$1" init -q; git -C "$dest/$1" remote add origin "https://github.com/$2"
  git -C "$dest/$1" fetch -q --depth 1 origin "$3"; git -C "$dest/$1" checkout -q FETCH_HEAD
}
get mocha mochajs/mocha 5b5afa7b12e3f76f4e0c6afa12e960c0b378358c   # JavaScript
get nest  nestjs/nest   085f83a168e9edbedfe9560428dcfd270073ae00   # TypeScript
get click pallets/click 08b803cf32ceb2ae6a772c62d5da42757a897d44   # Python
