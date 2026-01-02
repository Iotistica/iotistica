#!/usr/bin/env bash
set -euo pipefail

# scripts/runner-setup.sh
# Install dependencies, Docker, create `ghrunner` and register GitHub Actions runner
# Accepts runner onboarding token and an optional password for the `ghrunner` account.
# Usage: sudo ./runner-setup.sh --token <ONBOARDING_TOKEN> [--password <PASS>] [--url <URL>]

RUNNER_USER=ghrunner
RUNNER_HOME="/home/${RUNNER_USER}"
SERVICE_NAME=actions-runner.service
DEFAULT_URL="https://github.com/Iotistica"

usage() {
	cat <<EOF
Usage: $0 [options]

Options:
	-t, --token TOKEN       Runners onboarding token (or set RUNNERS_ONBOARDING_TOKEN)
	-p, --password PASS     Password to set for user '${RUNNER_USER}' (optional)
	-u, --url URL           GitHub repo/org URL (default: ${DEFAULT_URL})
	-n, --name NAME         Runner name (default: hostname-runner)
	-h, --help              Show this help and exit

Environment variables:
	RUNNERS_ONBOARDING_TOKEN  Alternative to --token
	RUNNERS_URL               Alternative to --url

Examples:
	sudo $0 --token abc123
	sudo $0 --token abc123 --password s3cr3t
	sudo RUNNERS_ONBOARDING_TOKEN=abc123 $0
EOF
}

# defaults
TOKEN=""
PASSWORD=""
HOSTNAME=""
URL="${DEFAULT_URL}"
NAME="$(hostname)"
NAME="${NAME^^}"

while [[ $# -gt 0 ]]; do
	case "$1" in
		-t|--token)
			TOKEN="$2"; shift 2;;
		-p|--password)
			PASSWORD="$2"; shift 2;;
		-u|--url)
			URL="$2"; shift 2;;
		-n|--name)
			NAME="$2"; shift 2;;
		-h|--help)
			usage; exit 0;;
		*)
			echo "Unknown option: $1" >&2; usage; exit 2;;
	esac
done

# fallback to env
: "${TOKEN:=${RUNNERS_ONBOARDING_TOKEN:-}}"
: "${URL:=${RUNNERS_URL:-${DEFAULT_URL}}}"

if [[ -z "$TOKEN" ]]; then
	echo "ERROR: onboarding token is required." >&2
	usage
	exit 1
fi

if [[ $EUID -ne 0 ]]; then
	echo "This script must be run as root (sudo)." >&2
	exit 1
fi

# BitBake + AppArmor User Namespace Restriction Fix. (https://developerwiki.proventusnova.com/Error:_BitBake_+_AppArmor_User_Namespace_Restriction_Fix)
mv /etc/apparmor.d/unprivileged_userns /etc/apparmor.d/unprivileged_userns.disabled

echo "[info] Installing Azure CLI..."
apt-get install -y ca-certificates curl apt-transport-https lsb-release gnupg
curl -sL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor | tee /etc/apt/keyrings/microsoft.gpg > /dev/null
chmod a+r /etc/apt/keyrings/microsoft.gpg
DISTRO=$(lsb_release -cs)
tee /etc/apt/sources.list.d/azure-cli.list > /dev/null <<EOF
deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/microsoft.gpg] https://packages.microsoft.com/repos/azure-cli/ $DISTRO main
EOF

echo "[info] Installing base packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl apt-transport-https lsb-release gnupg jq git wget tar lsb-release gnupg2 sudo azure-cli

echo "[info] Installing Docker repository and packages..."

# Ensure keyrings directory exists
install -m 0755 -d /etc/apt/keyrings

# Download and convert docker GPG key
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
    gpg --dearmor | tee /etc/apt/keyrings/docker.gpg > /dev/null

chmod a+r /etc/apt/keyrings/docker.gpg || true

# Detect correct codename (noble for Ubuntu 24.04)
DIST_CODENAME=$( . /etc/os-release && echo "${VERSION_CODENAME}" )

# Create docker.sources (the new supported method for Noble)
tee /etc/apt/sources.list.d/docker.sources > /dev/null <<EOF
Enabled: yes
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${DIST_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.gpg
EOF

# Update and install docker packages
apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

echo "[info] Creating runner user and groups..."
if ! id -u "$RUNNER_USER" >/dev/null 2>&1; then
	adduser --disabled-login --gecos "" "$RUNNER_USER"
fi
usermod -aG sudo,docker "$RUNNER_USER" || true
echo "$RUNNER_USER ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/99-nopasswd-sudo
chmod 440 /etc/sudoers.d/99-nopasswd-sudo

if [[ -n "$PASSWORD" ]]; then
	echo "[info] Setting password for user ${RUNNER_USER}"
	echo "${RUNNER_USER}:${PASSWORD}" | chpasswd
	# unlock account if it was locked
	passwd -u "${RUNNER_USER}" || true
fi

echo "[info] Downloading latest GitHub Actions runner..."
LATEST_TAG=$(curl -sSfL https://api.github.com/repos/actions/runner/releases/latest | jq -r .tag_name)
if [[ -z "$LATEST_TAG" || "$LATEST_TAG" == "null" ]]; then
	echo "Failed to determine latest runner release" >&2
	exit 1
fi
VERSION=${LATEST_TAG#v}
ARCHIVE="actions-runner-linux-x64-${VERSION}.tar.gz"
DOWNLOAD_URL="https://github.com/actions/runner/releases/download/${LATEST_TAG}/${ARCHIVE}"

mkdir -p /tmp/actions-runner
curl -fsSL -o "/tmp/${ARCHIVE}" "$DOWNLOAD_URL"
mkdir -p "${RUNNER_HOME}/actions-runner"
tar -xzf "/tmp/${ARCHIVE}" -C "${RUNNER_HOME}/actions-runner"
chown -R "${RUNNER_USER}:${RUNNER_USER}" "${RUNNER_HOME}/actions-runner"

echo "[info] Configuring runner (non-interactive)..."
sudo -u "$RUNNER_USER" bash -c "cd '${RUNNER_HOME}/actions-runner' && ./config.sh --unattended --url '${URL}' --token '${TOKEN}' --name '${NAME}' --work _work"

echo "[info] Creating systemd service file at /etc/systemd/system/${SERVICE_NAME}"
tee /etc/systemd/system/${SERVICE_NAME} > /dev/null <<EOF
[Unit]
Description=GitHub Actions Runner
After=network.target

[Service]
Type=simple
User=${RUNNER_USER}
WorkingDirectory=${RUNNER_HOME}/actions-runner
ExecStart=${RUNNER_HOME}/actions-runner/run.sh
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

chmod 644 /etc/systemd/system/${SERVICE_NAME}
systemctl daemon-reload
systemctl enable ${SERVICE_NAME}
systemctl start ${SERVICE_NAME}

echo "[success] Runner installed and service started. Check status with: systemctl status ${SERVICE_NAME}"
echo "If you need to reconfigure the runner later, run: sudo -u ${RUNNER_USER} ${RUNNER_HOME}/actions-runner/config.sh --replace --token <TOKEN> --url <URL>"

exit 0