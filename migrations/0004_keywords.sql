-- Keyword links: /k/<key> lands a visitor on one lesson (after a free join if they are new).
ALTER TABLE lessons ADD COLUMN keyword TEXT;
UPDATE lessons SET keyword='welcome' WHERE id=1;
CREATE UNIQUE INDEX IF NOT EXISTS lessons_keyword ON lessons(keyword);
