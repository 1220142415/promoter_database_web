#!/usr/bin/env bash
set -euo pipefail

release_root=${1:?usage: preprocess-gtdb-release.sh RELEASE_ROOT [SCORE_CONVERTER] [SCORE_ROOT]}
score_converter=${2:-}
score_root=${3:-}

for tool in bgzip tabix samtools gzip; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "missing required preprocessing tool: $tool" >&2
    exit 2
  }
done

shopt -s nullglob
objects=("$release_root"/objects/*)
if ((${#objects[@]} == 0)); then
  echo "no release objects found under $release_root/objects" >&2
  exit 2
fi

recompress_bgzf() {
  local path=$1
  local temporary="${path}.bgzf.tmp"
  gzip -dc -- "$path" | bgzip -@ 1 -c >"$temporary"
  mv -f -- "$temporary" "$path"
}

count=0
for object_root in "${objects[@]}"; do
  [[ -d "$object_root" ]] || continue

  reference="$object_root/reference.fa.gz"
  promoters="$object_root/predicted-promoters.gff3.gz"
  [[ -s "$reference" && -s "$promoters" ]] || {
    echo "incomplete object directory: $object_root" >&2
    exit 2
  }

  recompress_bgzf "$reference"
  samtools faidx "$reference"
  [[ -s "${reference}.fai" && -s "${reference}.gzi" ]] || {
    echo "samtools did not create both FASTA indexes for $reference" >&2
    exit 2
  }

  recompress_bgzf "$promoters"
  tabix -f -p gff "$promoters"

  annotations="$object_root/ncbi-annotations.gff3.gz"
  if [[ -s "$annotations" ]]; then
    recompress_bgzf "$annotations"
    tabix -f -p gff "$annotations"
  fi

  count=$((count + 1))
  if ((count % 100 == 0)); then
    echo "indexed $count release objects" >&2
  fi
done

if [[ -n "$score_converter" || -n "$score_root" ]]; then
  [[ -n "$score_converter" && -n "$score_root" ]] || {
    echo "score converter and score root must be supplied together" >&2
    exit 2
  }
  command -v python3 >/dev/null 2>&1 || {
    echo "missing required score conversion tool: python3" >&2
    exit 2
  }
  python3 -c 'import pyarrow, pyBigWig' >/dev/null 2>&1 || {
    echo "score conversion requires the pyarrow and pyBigWig Python packages" >&2
    exit 2
  }
  python3 "$score_converter" \
    --score-root "$score_root" \
    --release-root "$release_root" \
    --stride 50
fi

echo "indexed $count release objects" >&2
