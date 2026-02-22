# SeagullNotes

Minimal note-taking app on GitHub Pages. All in the browser: set your repo and token, then create and edit notes that are stored as files in your GitHub repo under `notes/`.

## Features

- **Editable repo**: Set and change which repo notes are saved to (owner + repo name) in the UI; stored in the browser (localStorage).
- **Auto notes directory**: If the repo has no `notes/` folder, it is created automatically on first use.
- **View saved notes**: Sidebar lists notes and folders under `notes/`; click a file to open it, click a folder to browse.
- **Markdown**: Notes can be `.md` or `.txt`. Use the Preview button to render markdown.
- **Delete**: Delete the currently open note (with confirmation).
- **Images**: Use "Add image" to upload an image; it is stored in the repo (under `notes/images/`) and a markdown image link is inserted. You can also use `![alt](url)` with any URL.
- **Directories**: Save notes in paths like `work/meeting.md`; create folders with "New folder".

## Setup

1. **GitHub Pages**: In this repo, Settings → Pages → Deploy from branch → `main` → root.
2. **Token**: Create a Personal Access Token (classic or fine-grained) with repo Contents read/write. Paste it in the app and click Save token (stored in browser only).
3. **Repo**: Enter the owner and repo name where notes should be saved and click "Use repo". Or set them in `config.js` as default.

The token is only sent to GitHub’s API; the app runs entirely in your browser.
