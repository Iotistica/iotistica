# Iotistica Agent — Troubleshooting

## Check agent status

```bash
systemctl status iotistica-agent
```

```bash
journalctl -u iotistica-agent -f
```

Ping the local API (confirms the agent process is up and listening):

```bash
curl -s http://localhost:48484/ping
```

---

## Check first-run setup status

On a fresh install, Node.js, Docker, and Mosquitto are installed in the background by `iotistica-setup.service`. The agent only starts after setup completes (~1–3 min).

```bash
# Watch setup progress live
journalctl -u iotistica-setup -f

# Check whether setup has finished
ls /var/lib/iotistic/setup-complete
```

If `setup-complete` exists, setup is done. If the agent is still not running after that, check its logs with `journalctl -u iotistica-agent -f`.

---

## Port 1883 conflict (Mosquitto)

**Symptom:** `journalctl -u mosquitto` shows `Address already in use` on port 1883. Usually caused by a Docker container already bound to that port.

**Check what's on port 1883:**

```bash
sudo ss -tlnp | grep 1883
```

**Fix — switch Mosquitto to a different port (e.g. 8883):**

```bash
# 1. Change the Mosquitto listener port
sudo nano /etc/mosquitto/conf.d/iotistica.conf
# Change:  listener 1883
# To:      listener 8883

# 2. Update the agent to match
sudo nano /etc/iotistic/agent.env
# Change:  MQTT_BROKER_URL=mqtt://localhost:1883
# To:      MQTT_BROKER_URL=mqtt://localhost:8883

# 3. Restart both services
sudo systemctl restart mosquitto
sudo systemctl restart iotistica-agent
```

**Alternative — set port at install time** (before setup has run):

```bash
sudo MQTT_BROKER_PORT=8883 dpkg -i iotistica-agent_*.deb
```

---

## Admin UI not reachable

**Symptom:** Browser can't connect to `http://<device-ip>:48484/admin/`.

**Check which address the agent is listening on:**

```bash
sudo ss -tlnp | grep node
```

If it shows `127.0.0.1:48484` instead of `0.0.0.0:48484`, `API_SECURITY_MODE` is set to `LOCALHOST_ONLY`. Fix:

```bash
sudo nano /etc/iotistic/agent.env
# Set:  API_SECURITY_MODE=LOCAL_NETWORK

sudo systemctl restart iotistica-agent
```

---

## Agent fails to start — module not found

**Symptom:** `journalctl -u iotistica-agent` shows `Cannot find module '...'`.

Likely cause: corrupted or missing `node_modules`. Reinstall the package:

```bash
sudo apt install ./iotistica-agent_*.deb
```

Or as a quick workaround if `node_modules` is missing but packages are present in the agent directory:

```bash
sudo ln -s . /opt/iotistic/agent/node_modules
sudo systemctl restart iotistica-agent
```

---

## Reinstall / upgrade

Reinstalling over an existing installation preserves `agent.env` and data. Setup does not re-run (guarded by `setup-complete` flag).

```bash
sudo apt install ./iotistica-agent_<version>_arm64.deb
# or
sudo dpkg -i iotistica-agent_<version>_arm64.deb
```

Use `dpkg -i` instead of `apt install ./` to avoid the harmless `_apt` permission warning that appears when the `.deb` is in a home directory.

---

## Useful log commands

```bash
# Agent logs (last 50 lines)
journalctl -u iotistica-agent -n 50 --no-pager

# First-run setup logs
journalctl -u iotistica-setup --no-pager

# Mosquitto logs
journalctl -u mosquitto -n 50 --no-pager

# All Iotistica services at once
journalctl -u 'iotistica-*' -f
```
