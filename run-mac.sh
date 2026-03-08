#!/bin/bash
cd "$(dirname "$0")"

echo "=========================================="
echo "  Qlipper AI v1.8.5"
echo "=========================================="
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "ERROR: Node.js is not installed."
    echo "Please install from: https://nodejs.org/"
    exit 1
fi

echo "Node.js: $(node -v)"

# Install backend dependencies
echo ""
echo "[1/3] Installing backend dependencies..."
cd backend
npm install
if [ $? -ne 0 ]; then
    echo "WARNING: npm install had errors. Retrying with --force..."
    npm install --force
fi
cd ..

# Verify node_modules
if [ ! -d "backend/node_modules/express" ]; then
    echo "ERROR: Dependencies not installed. Please check your internet and run:"
    echo "  cd backend && npm install"
    read -p "Press Enter to exit..."
    exit 1
fi

# Clear macOS quarantine & ad-hoc codesign binaries (Ventura+ requirement)
if [ -d "backend/bin" ]; then
    xattr -cr backend/bin 2>/dev/null
    for f in backend/bin/*; do
        [ -f "$f" ] && codesign --force --deep -s - "$f" 2>/dev/null
    done
fi

# Run preflight (checks yt-dlp, ffmpeg, creates dirs)
echo ""
echo "[2/3] Running preflight checks..."
node backend/preflight.js

if [ $? -ne 0 ]; then
    echo ""
    echo "Preflight failed. Please fix the errors above."
    read -p "Press Enter to exit..."
    exit 1
fi

# Start server
echo ""
echo "[3/3] Starting Qlipper AI..."
echo ""
echo "=========================================="
echo "  Open in browser: http://localhost:3001"
echo "  Press Ctrl+C to stop"
echo "=========================================="
echo ""

node backend/server.js
