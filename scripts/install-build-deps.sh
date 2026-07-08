#!/usr/bin/env bash
# Instala dependencias de build para AppImage en SteamOS, Bazzite y otras distros.
# Uso: source scripts/install-build-deps.sh  (o ejecutar directamente)
set -euo pipefail

_install_build_deps() {
  local missing=()
  local cmd

  for cmd in python3 patchelf file wget mksquashfs; do
    if ! command -v "${cmd}" >/dev/null 2>&1; then
      missing+=("${cmd}")
    fi
  done

  if [[ "${#missing[@]}" -eq 0 ]]; then
    echo "==> Dependencias de build ya presentes"
    return 0
  fi

  echo "==> Faltan herramientas: ${missing[*]}"

  # Bazzite / Fedora Silverblue / Kinoite (OSTree inmutable)
  if command -v rpm-ostree >/dev/null 2>&1 && [[ -f /run/ostree-booted ]]; then
    echo "==> Instalando con rpm-ostree (Bazzite / Fedora Atomic)"
    sudo rpm-ostree install -y --allow-inactive \
      python3 python3-pip python3-devel \
      gcc gcc-c++ make \
      patchelf file zsync wget \
      dbus-devel glib2-devel cairo-devel gobject-introspection-devel pkgconf-pkg-config \
      fuse fuse-libs squashfs-tools \
      binutils
    echo ""
    echo "Si rpm-ostree pide reinicio, reinicia el sistema y vuelve a ejecutar:"
    echo "  ./scripts/build-appimage.sh"
    return 0
  fi

  # Fedora / RHEL (mutable, toolbox, distrobox, etc.)
  if command -v dnf >/dev/null 2>&1; then
    echo "==> Instalando con dnf (Fedora / RHEL)"
    sudo dnf install -y \
      python3 python3-pip python3-devel \
      gcc gcc-c++ make \
      patchelf file zsync wget \
      dbus-devel glib2-devel cairo-devel gobject-introspection-devel pkgconf-pkg-config \
      fuse fuse-libs squashfs-tools \
      binutils
    return 0
  fi

  # SteamOS / Arch
  if command -v pacman >/dev/null 2>&1; then
    echo "==> Instalando con pacman (SteamOS / Arch)"
    sudo pacman -Sy --noconfirm
    sudo pacman -S --needed --noconfirm \
      python python-pip python-virtualenv \
      base-devel patchelf file zsync wget \
      dbus glib2 gobject-introspection cairo pkgconf fuse2 squashfs \
      binutils
    return 0
  fi

  # Debian / Ubuntu
  if command -v apt-get >/dev/null 2>&1; then
    echo "==> Instalando con apt (Debian / Ubuntu)"
    sudo apt-get update -qq
    sudo apt-get install -y --no-install-recommends \
      python3 python3-venv python3-pip python3-dev \
      build-essential patchelf file zsync wget \
      libdbus-1-dev libglib2.0-dev libgirepository1.0-dev \
      libcairo2-dev pkg-config \
      fuse libfuse2 squashfs-tools \
      binutils
    return 0
  fi

  echo "error: no se encontró rpm-ostree, dnf, pacman ni apt-get." >&2
  echo "Instala manualmente: python3 patchelf file wget gcc make" >&2
  exit 1
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  _install_build_deps
fi
