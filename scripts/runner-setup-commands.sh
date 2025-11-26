packages:

az cli
curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash

###

apt install git bc curl wget tar nano jq azure-cli -y

# Add Docker's official GPG key:
apt update
apt install ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc

# Add the repository to Apt sources:
tee /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Signed-By: /etc/apt/keyrings/docker.asc
EOF

apt update
apt install docker-ce docker-ce-cli

####

adduser ghrunner
passwd -u ghrunner

usermod -aG sudo ghrunner
usermod -aG docker ghrunner
echo 'ghrunner ALL=(ALL) NOPASSWD: ALL' | tee /etc/sudoers.d/99-nopasswd-sudo

###

https://docsaid.org/en/blog/ubuntu-github-runner-systemd/

nano /etc/systemd/system/actions-runner.service

###

[Unit]
Description=GitHub Action Runner
After=network.target

[Service]
Type=simple
User=ghrunner
WorkingDirectory=/home/ghrunner/actions-runner
ExecStart=/home/ghrunner/actions-runner/run.sh
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target

###

systemctl daemon-reload
systemctl enable actions-runner.service
systemctl start actions-runner.service
systemctl status actions-runner.service