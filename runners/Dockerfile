FROM ghcr.io/actions/actions-runner:latest

ARG EXTRA_APT_PACKAGES="bc make g++ jq netcat-openbsd curl git"
ARG DOCKER_COMPOSE_VERSION="v2.34.0"
ARG YQ_VERSION="v4.44.3"

RUN sudo apt-get update \
  && if [ -n "${EXTRA_APT_PACKAGES}" ]; then sudo apt-get install -y --no-install-recommends ${EXTRA_APT_PACKAGES}; fi \
  && sudo rm -rf /var/lib/apt/lists/*

# Azure CLI
RUN curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash \
  && sudo rm -rf /var/lib/apt/lists/*

# Docker Compose v2 CLI plugin
RUN sudo mkdir -p /usr/local/lib/docker/cli-plugins \
  && sudo curl -SL "https://github.com/docker/compose/releases/download/${DOCKER_COMPOSE_VERSION}/docker-compose-linux-x86_64" -o /usr/local/lib/docker/cli-plugins/docker-compose \
  && sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# yq - YAML processor
RUN sudo curl -SL "https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/yq_linux_amd64" -o /usr/local/bin/yq \
  && sudo chmod +x /usr/local/bin/yq