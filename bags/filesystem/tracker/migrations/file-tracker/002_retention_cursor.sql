-- Cursor keeps unknown or pinned sessions from starving later eligible records.
CREATE TABLE tracker_retention (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  cursor TEXT NOT NULL DEFAULT ''
);
INSERT INTO tracker_retention(singleton) VALUES (1);
