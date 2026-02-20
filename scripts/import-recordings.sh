#!/bin/bash
#
# import-recordings.sh — Copy .wav files from USB recorder to audio-inbox
#
# Usage:
#   ./scripts/import-recordings.sh /Volumes/RECORDER    # macOS
#   ./scripts/import-recordings.sh /media/user/RECORDER  # Linux
#   ./scripts/import-recordings.sh /path/to/folder       # Any folder with .wav files
#
# What it does:
#   1. Finds all .wav files on the USB drive (recursively)
#   2. Copies new files to data/audio-inbox/ (skips already-imported files)
#   3. The transcript-ingest watcher picks them up automatically
#
# Files are COPIED, not moved — your recorder keeps the originals.
# Already-imported files (by name) are skipped to avoid duplicates.

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Project root (relative to this script)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
INBOX_DIR="$PROJECT_ROOT/data/audio-inbox"
PROCESSED_DIR="$PROJECT_ROOT/data/audio-processed"

# Check args
if [ $# -eq 0 ]; then
    echo -e "${RED}Usage: $0 <path-to-usb-drive-or-folder>${NC}"
    echo ""
    echo "Examples:"
    echo "  $0 /Volumes/RECORDER"
    echo "  $0 /media/user/RECORDER"
    echo "  $0 ~/Downloads/recordings"
    echo ""
    # Try to auto-detect mounted USB drives
    echo "Looking for mounted drives..."
    if [ -d "/Volumes" ]; then
        # macOS
        for vol in /Volumes/*/; do
            [ "$vol" = "/Volumes/Macintosh HD/" ] && continue
            count=$(find "$vol" -iname "*.wav" 2>/dev/null | wc -l | tr -d ' ')
            if [ "$count" -gt 0 ]; then
                echo -e "  ${GREEN}Found: $vol ($count .wav files)${NC}"
            fi
        done
    elif [ -d "/media" ]; then
        # Linux
        for vol in /media/*/*/; do
            count=$(find "$vol" -iname "*.wav" 2>/dev/null | wc -l | tr -d ' ')
            if [ "$count" -gt 0 ]; then
                echo -e "  ${GREEN}Found: $vol ($count .wav files)${NC}"
            fi
        done
    fi
    exit 1
fi

SOURCE_DIR="$1"

if [ ! -d "$SOURCE_DIR" ]; then
    echo -e "${RED}Error: '$SOURCE_DIR' is not a directory${NC}"
    exit 1
fi

# Ensure inbox exists
mkdir -p "$INBOX_DIR"

# Build list of already-processed files (strip timestamp prefix)
already_imported=""
if [ -d "$PROCESSED_DIR" ]; then
    already_imported=$(ls "$PROCESSED_DIR" 2>/dev/null | sed 's/^[0-9]*_//' | sed 's/^ERROR_[0-9]*_//' | sort -u)
fi
# Also check inbox (files currently being processed)
if [ -d "$INBOX_DIR" ]; then
    inbox_files=$(ls "$INBOX_DIR" 2>/dev/null | sort -u)
    already_imported=$(printf '%s\n%s' "$already_imported" "$inbox_files" | sort -u)
fi

# Find and copy .wav files
echo -e "${YELLOW}Scanning $SOURCE_DIR for .wav files...${NC}"
total=0
copied=0
skipped=0

while IFS= read -r -d '' wav_file; do
    total=$((total + 1))
    basename=$(basename "$wav_file")

    # Skip if already imported
    if echo "$already_imported" | grep -qxF "$basename"; then
        skipped=$((skipped + 1))
        continue
    fi

    # Copy to inbox
    size=$(du -h "$wav_file" | cut -f1)
    echo -e "  Copying: ${GREEN}$basename${NC} ($size)"
    cp "$wav_file" "$INBOX_DIR/$basename"
    copied=$((copied + 1))

done < <(find "$SOURCE_DIR" -iname "*.wav" -print0 | sort -z)

echo ""
echo -e "${GREEN}Done.${NC} Found $total files, copied $copied new, skipped $skipped already-imported."

if [ $copied -gt 0 ]; then
    echo -e "${YELLOW}Files are now in $INBOX_DIR${NC}"
    echo "The transcript ingest watcher will process them automatically."
fi
