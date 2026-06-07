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
# --extra-ldflags="-static ...": statically link the MinGW C/C++ runtime
# (libgcc, libstdc++, libwinpthread) into ffmpeg.exe so it runs standalone in a
# plain PowerShell/cmd (no MSYS2 DLLs on PATH). Without this the exe fails with
# 0xC0000139 (entry point / DLL not found) outside the MSYS2 shell.
./configure \
  --arch=x86_64 \
  --target-os=mingw32 \
  --disable-autodetect \
  --disable-shared \
  --enable-static \
  --disable-doc \
  --disable-ffprobe \
  --disable-network \
  --disable-debug \
  --extra-ldflags="-static -static-libgcc -static-libstdc++"

echo "=== build ==="
make -j"$(nproc)" ffmpeg.exe

cp -f ffmpeg.exe "${OUT_DIR}/ffmpeg.exe"
echo "=== built ${OUT_DIR}/ffmpeg.exe ==="

# Verify standalone-portability: no MinGW runtime DLL deps should remain.
# (ldd is available in MSYS2; list non-system DLL dependencies.)
echo "=== ffmpeg.exe DLL dependencies (expect only Windows system DLLs) ==="
if command -v ldd >/dev/null 2>&1; then
  deps="$(ldd "${OUT_DIR}/ffmpeg.exe" 2>/dev/null || true)"
  echo "${deps}"
  bad="$(echo "${deps}" | grep -iE 'libgcc|libstdc\+\+|libwinpthread|mingw|/mingw64/' || true)"
  if [ -n "${bad}" ]; then
    echo "ERROR: ffmpeg.exe still depends on MinGW runtime DLLs (not standalone):"
    echo "${bad}"
    exit 1
  fi
  echo "OK: no MinGW runtime DLL dependencies — ffmpeg.exe is standalone."
fi

"${OUT_DIR}/ffmpeg.exe" -hide_banner -version | head -n 3
