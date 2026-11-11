-- Sample content so the app is not empty on first run. Edit or delete it from Admin, then Courses.
INSERT INTO courses (id, title, description, plus_only, position) VALUES (1, 'Start here', 'A few sample lessons. Replace them with your own from Admin, then Courses.', 0, 0);
INSERT INTO modules (id, course_id, title, position) VALUES (1, 1, 'Welcome', 0);
INSERT INTO lessons (id, module_id, title, body_md, youtube_id, position) VALUES (1, 1, 'Welcome', 'This is a sample lesson. Lessons are written in Markdown.

Anything inside a prompt block gets a Copy button:

```prompt
Explain what this community is for in two sentences, then ask me what I want to build first.
```

Mark the lesson done when you finish it.', NULL, 0);
INSERT INTO lessons (id, module_id, title, body_md, youtube_id, position) VALUES (2, 1, 'How to post', 'Open the feed, pick a category and write your post. Other members can like it and comment. Every like you receive is one point toward your level.', NULL, 1);
INSERT INTO modules (id, course_id, title, position) VALUES (2, 1, 'Make it yours', 1);
INSERT INTO lessons (id, module_id, title, body_md, youtube_id, position) VALUES (3, 2, 'Rename the community', 'Open Claude Code in this folder and paste this:

```prompt
Read src/config.ts and the README. Rename this community to [NAME], set the tagline to [TAGLINE] and the accent color to [COLOR]. Then run the tests and tell me what changed.
```', NULL, 0);
INSERT INTO courses (id, title, description, plus_only, position) VALUES (2, 'Plus course (sample)', 'A sample course only paid members can open.', 1, 1);
INSERT INTO modules (id, course_id, title, position) VALUES (3, 2, 'Members only', 0);
INSERT INTO lessons (id, module_id, title, body_md, youtube_id, position) VALUES (4, 3, 'Sample Plus lesson', 'Only Plus members and admins can read this.', NULL, 0);
INSERT INTO events (title, description, starts_at, duration_min, link, weekly, placeholder) VALUES ('Weekly live session', 'A sample weekly event. Set the day and time from Admin, then Events.', NULL, 60, '', 1, 1);
