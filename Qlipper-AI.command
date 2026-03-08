#!/bin/bash
cd "$(dirname "$0")"
# Clear quarantine + ad-hoc sign binaries for macOS Ventura+
if [ -d "backend/bin" ]; then
    xattr -cr backend/bin 2>/dev/null
    for f in backend/bin/*; do
        [ -f "$f" ] && codesign --force --deep -s - "$f" 2>/dev/null
    done
fi
./run-mac.sh
