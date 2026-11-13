#!/bin/sh
# IDTAP_PYTHON_PATH for local staging. The server spawns Python for spectrograms,
# melographs, audio processing, exports and two midnight cron jobs:
# delete_unlinked_audio.py (deletes media no DB record links to) and
# backups/backup_mongo.py. None of them may run against staging data, so every
# spawn is refused loudly instead.
echo "idtap staging: Python is disabled (would have run: $*)" >&2
exit 1
