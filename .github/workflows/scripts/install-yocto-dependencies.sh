#!/bin/bash
set -e

echo "Installing Yocto build dependencies..."

# Check if already installed
if command -v bitbake &> /dev/null; then
  echo "✓ Yocto tools already installed"
fi

# Install Python 3.8 for older Yocto versions (kirkstone)
echo "Installing Python 3.8 for Yocto compatibility..."
sudo apt-get update
sudo apt-get install -y software-properties-common
sudo add-apt-repository -y ppa:deadsnakes/ppa
sudo apt-get update
sudo apt-get install -y python3.8 python3.8-dev python3.8-distutils

# Install dependencies (Ubuntu/Debian)
sudo apt-get install -y \
  gawk wget git diffstat unzip texinfo gcc build-essential \
  chrpath socat cpio python3-pip python3-pexpect \
  xz-utils debianutils iputils-ping python3-git python3-jinja2 \
  libsdl1.2-dev pylint xterm python3-subunit mesa-common-dev \
  zstd liblz4-tool file locales libacl1

# Set locale
sudo locale-gen en_US.UTF-8

echo "✓ Dependencies installed"
