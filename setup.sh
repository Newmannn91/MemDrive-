#!/bin/sh
# MemDrive setup launcher (macOS / Linux).
# Thin shell only: all logic lives in the Node wizard
# (node dist/index.js setup). Run from a terminal:
#   ./setup.sh
# On macOS, double-click setup.command instead.

# Run from this script's own directory, wherever it was started from.
cd "$(dirname "$0")" || exit 1

# 1. Node.js must be installed. MemDrive needs Node 18 or newer.
if ! command -v node >/dev/null 2>&1; then
  echo
  echo "Node.js is not installed on this computer."
  echo "MemDrive needs Node.js 18 or newer. Download it from the"
  echo "official site (it is free), install it, then run setup.sh again."
  echo
  printf "Open https://nodejs.org in your browser now? [y/N] "
  read -r answer
  case "$answer" in
    [Yy]*)
      if [ "$(uname)" = "Darwin" ]; then
        open "https://nodejs.org"
      elif command -v xdg-open >/dev/null 2>&1; then
        xdg-open "https://nodejs.org"
      else
        echo "No browser opener found. Go to https://nodejs.org yourself."
      fi
      ;;
  esac
  echo "Setup stopped. Nothing was changed."
  exit 1
fi
node -v
if ! node -e "if (Number(process.versions.node.split('.')[0]) < 18) { console.error('Node.js 18 or newer is required. Your version is ' + process.version + '. Please update Node.js, then run setup.sh again.'); process.exit(1); }"; then
  echo "Setup stopped. Nothing was changed."
  exit 1
fi

# 2. Install dependencies and build. Failures are shown plainly
# and stop the script; nothing is written to any app config yet.
echo
echo "Installing dependencies..."
if ! npm install; then
  echo
  echo '"npm install" failed. Check the error above and try again.'
  echo "Setup stopped. Nothing was changed."
  exit 1
fi
echo
echo "Building..."
if ! npm run build; then
  echo
  echo '"npm run build" failed. Check the error above and try again.'
  echo "Setup stopped. Nothing was changed."
  exit 1
fi

# 3. Run the wizard.
echo
node dist/index.js setup
