# GitHub Actions Runner setup

This document explains how to run the provided onboarding scripts to install a GitHub Actions self-hosted runner on Windows and Linux.

Files
- Windows PowerShell installer
  - onboard_github_runner_windows.ps1
- Linux installer (Debian/Ubuntu)
  - runner-setup.sh


Get a registration token and org url by login to https://github.com/organizations/Iotistica/settings/actions/runners and click 'New runner -> New self-hosted runner' and copy the token and url from Configure block.

Execute:

Windows (Powershell): 

.\onboard_github_runner_windows.ps1 <TOKEN> <URL>

Linux (Shell):

nano run.sh
chmod +x run.sh
sudo ./run.sh --token <TOKEN> --password <PASSWORD>