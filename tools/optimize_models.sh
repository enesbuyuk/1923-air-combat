#!/usr/bin/env bash
# Compresses the aircraft GLBs for the web with glTF Transform (fetched through npx).
# Writes to a separate directory and never touches the originals or the R2 bucket.
#
# Usage:
#   tools/optimize_models.sh [in_dir] [out_dir]      # defaults: web/models dist/models
#
# Environment:
#   TEXTURES=ktx2|webp|keep   ktx2 (default) needs the `ktx` CLI from KTX-Software 4.3+
#                             (brew install ktx-software); without it webp is used.
#                             KTX2 stays compressed on the GPU, webp only shrinks the download.
#   TEXTURE_SIZE=2048         longest texture edge; 0 keeps the source size (4096)
#   GEOMETRY=meshopt|draco|none
#
# Node names, the node hierarchy and material names are kept (no join / flatten / palette /
# instance / simplify): models.js toggles gear nodes by name and models.json matches
# materials by name. models.js loads the KTX2, Draco and Meshopt decoders on demand.
#
# Afterwards: check the results locally (copy over web/models/*.glb, ./build.sh serve), bump
# "version" in web/models/models.json, then upload with tools/upload_models.sh <out_dir>.
set -euo pipefail
cd "$(dirname "$0")/.."

in_dir="${1:-web/models}"
out_dir="${2:-dist/models}"
textures="${TEXTURES:-ktx2}"
size="${TEXTURE_SIZE:-2048}"
geometry="${GEOMETRY:-meshopt}"
gt=(npx --yes "${GLTF_TRANSFORM:-@gltf-transform/cli@4}")

if [[ "$textures" == "ktx2" ]] && ! command -v ktx >/dev/null 2>&1; then
  echo "ktx (KTX-Software) not found, using webp textures instead" >&2
  textures=webp
fi

mkdir -p "$out_dir"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

for src in "$in_dir"/*.glb; do
  name="$(basename "$src")"
  out="$out_dir/$name"
  echo "== $name"

  # Dedup, prune, weld and geometry compression without changing the scene structure.
  "${gt[@]}" optimize "$src" "$work/a.glb" \
    --compress "$( [[ "$geometry" == none ]] && echo false || echo "$geometry" )" \
    --texture-compress false \
    --simplify false --join false --flatten false --instance false --palette false

  if [[ "$size" != "0" ]]; then
    "${gt[@]}" resize "$work/a.glb" "$work/b.glb" --width "$size" --height "$size"
  else
    cp "$work/a.glb" "$work/b.glb"
  fi

  case "$textures" in
    ktx2)
      # UASTC for data maps (normal, ORM) where ETC1S artefacts show; ETC1S for the rest.
      "${gt[@]}" uastc "$work/b.glb" "$work/c.glb" \
        --slots "{normalTexture,occlusionTexture,metallicRoughnessTexture}" --level 2 --rdo --zstd 18
      "${gt[@]}" etc1s "$work/c.glb" "$out" --quality 255
      ;;
    webp) "${gt[@]}" webp "$work/b.glb" "$out" ;;
    keep) cp "$work/b.glb" "$out" ;;
    *) echo "unknown TEXTURES=$textures" >&2; exit 1 ;;
  esac

  echo "   $(wc -c < "$src") -> $(wc -c < "$out") bytes"
done
echo "OK: $out_dir"
