#!/bin/bash
# latest version    
bash <(curl -H 'Cache-Control: no-cache' -sL --proto '=https' https://apps.iotistica.com/install-agent)

# specific version
# tag="v1.2.3"
bash <(curl -H 'Cache-Control: no-cache' -sL --proto '=https' https://apps.iotistica.com/install-agent) v1.2.3

# Install or upgrade iotistic (formerly docker) engine
bash <(curl -H 'Cache-Control: no-cache' -sL --proto '=https' https://iotistica.com/install-engine)
