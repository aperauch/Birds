#!/usr/bin/env bash
# Install the Birds e-paper frame client on a Raspberry Pi.
# Enables SPI/I2C, creates a venv, installs deps, and registers a systemd timer.
#
# Usage: ./install.sh   (run from the frame/ directory on the Pi)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_USER="${SUDO_USER:-$(whoami)}"

echo "==> Enabling SPI and I2C interfaces"
if command -v raspi-config >/dev/null 2>&1; then
  sudo raspi-config nonint do_spi 0
  sudo raspi-config nonint do_i2c 0
else
  echo "    raspi-config not found; enable SPI/I2C manually if the panel fails."
fi

echo "==> Creating Python virtual environment"
python3 -m venv "${HERE}/.venv"
# shellcheck disable=SC1091
source "${HERE}/.venv/bin/activate"
pip install --upgrade pip
pip install -r "${HERE}/requirements.txt"
deactivate

if [[ ! -f /etc/birds-frame.toml ]]; then
  echo "==> Installing default config to /etc/birds-frame.toml (edit it!)"
  sudo cp "${HERE}/config.toml.example" /etc/birds-frame.toml
  echo "    Edit /etc/birds-frame.toml and set base_url + frame_key."
fi

echo "==> Installing systemd service + timer"
# Render the unit with the correct user/paths, then install.
sed -e "s#/home/pi/Birds/frame#${HERE}#g" \
    -e "s#^User=pi#User=${SERVICE_USER}#" \
    "${HERE}/birds-frame.service" | sudo tee /etc/systemd/system/birds-frame.service >/dev/null
sudo cp "${HERE}/birds-frame.timer" /etc/systemd/system/birds-frame.timer

sudo systemctl daemon-reload
sudo systemctl enable --now birds-frame.timer

echo "==> Done. Trigger an immediate refresh with:"
echo "    sudo systemctl start birds-frame.service"
echo "    journalctl -u birds-frame.service -n 30 --no-pager"
