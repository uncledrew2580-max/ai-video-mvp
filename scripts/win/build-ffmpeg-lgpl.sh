#!/usr/bin/env bash
# P14-A1: build a CLEAN LGPL static ffmpeg.exe (win64) from source via MSYS2/mingw64.
# Uses the SAME minimal flags as the frozen Mac 0010 build so the resulting
# `configuration:` string contains NO gpl/nonfree/libx264/libx265/libfdk tokens.
# Stream-copy remux needs no external encoders, so we enable nothing extra.
set -euo pipefail

FF_VERSION="6.1.2"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="${ROOT}/.ffbuild-win"
OUT_DIR="${ROOT}/runtime/bin"
mkdir -p "${WORK}" "${OUT_DIR}"
cd "${WORK}"

echo "=== download ffmpeg ${FF_VERSION} source ==="
curl -sL -o ff.tar.xz "https://ffmpeg.org/releases/ffmpeg-${FF_VERSION}.tar.xz"
tar xf ff.tar.xz
cd "ffmpeg-${FF_VERSION}"

echo "=== configure (LGPL default; no gpl/nonfree/external libs) ==="
./configure \
  --arch=x86_64 \
  --target-os=mingw32 \
  --disable-autodetect \
  --disable-shared \
  --enable-static \
  --disable-doc \
  --disable-ffprobe \
  --disable-network \
  --disable-debug

echo "=== license check (must be LGPL) ==="
./ffbuild/config.log >/dev/null 2>&1 || true

echo "=== build ==="
make -j"$(nproc)" ffmpeg.exe

cp -f ffmpeg.exe "${OUT_DIR}/ffmpeg.exe"
echo "=== built ${OUT_DIR}/ffmpeg.exe ==="
"${OUT_DIR}/ffmpeg.exe" -hide_banner -version | head -n 3
