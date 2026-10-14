Run `node --max-old-space-size=8192 --import tsx cli/scripts/verify-production-stores.ts` from the repository root with Node 26. An optional first argument selects another Barry App Support directory.

The script opens current built-in databases read-only and captures consistent SQLite backups into a private temporary directory. It migrates those copies, verifies all ordinary rows by count and content fingerprint across partitions and archives, checks identity ownership and database integrity, adopts SQL migration checksums, checks search indexes, and creates a backup and verifies every snapshot in it. The restore round trip is covered by `cli/src/commands/db-restore.test.ts`.

Live services continue running. Each database capture is consistent independently; this does not establish an atomic snapshot across databases. Vaults, adapter databases, and external bag databases are excluded. No model or network operation runs.

The printed report contains counts and paths. Migration archives also contain real application data, including unattributed records, and stay in the private scratch directory. Duplicate input copies are removed after comparison to make room for the backup. Keep sufficient disk space for archives, partitions, and a backup copy.

If a later check fails, run `node --max-old-space-size=8192 --import tsx cli/scripts/verify-production-stores.ts --resume /path/to/barry-production-verification-directory` to reuse an activated migration and its captures. A failure before activation requires inspecting the retained migration report and staging directory.

For crash recovery, set `TMPDIR` to a private persistent directory before starting verification. The default macOS temporary directory can be cleared on reboot. The verifier matches partitions by both bag and store and restores archived BLOB byte representations from JSON when resuming.
