# SeagullNotes

A minimal note-taking page hosted on GitHub Pages. Type a note, click Save, and it is pushed to this repo as a text file under `notes/`. Everything runs in your browser; no server or OAuth.

## Setup

### 1. Enable GitHub Pages

- In this repo: **Settings → Pages**.
- Under **Source**, choose **Deploy from a branch**.
- Branch: `main` (or your default branch). Folder: **/ (root)**.
- Save. The site will be at `https://<your-username>.github.io/SeagullNotes/`.

### 2. Create a GitHub token

You need a Personal Access Token so the page can write to the repo.

- **Fine-grained (recommended):** GitHub **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**. Limit to this repository only; set **Repository permissions → Contents** to **Read and write**.
- **Classic:** **Settings → Developer settings → Personal access tokens (classic)**. Create a token with the `repo` scope (or the minimal scope that allows writing repository contents).

### 3. Use the app

- Open the GitHub Pages URL (or open `index.html` locally).
- Paste your token into the token field and click **Save token**. The token is stored only in your browser (`localStorage`); it is never sent to any server except GitHub’s API.
- Optionally set a filename (default is `note-YYYY-MM-DD-HHmm.txt`).
- Type your note and click **Save**. The note is written to `notes/<filename>` in this repo.

### 4. Repo owner and name (optional)

By default the page uses the repo name **SeagullNotes** and expects the owner to be set in `config.js`. If you use the default `index.html` without `config.js`, replace `YOUR_GITHUB_USERNAME` in the script with your GitHub username, or add a `config.js` (see below) so the correct owner and repo are used.

## Optional: config.js

To set the repo without editing `index.html`, create a file `config.js` in the same folder as `index.html`:

```js
var CONFIG = {
  REPO_OWNER: 'your-github-username',
  REPO_NAME: 'SeagullNotes'
};
```

Do not put your token or any secrets in `config.js`. The token is only entered in the page and stored in the browser.

## Security and privacy

- The token is stored in your browser’s `localStorage`. Anyone with access to your device (or DevTools) can read it. Use a fine-grained token limited to this repo and Contents only to limit the impact if it is exposed.
- The token is only sent to `https://api.github.com` over HTTPS when you click Save.
- To stop using the app on this device, click **Log out** (clears the token from the browser). To revoke the token entirely, do that in GitHub **Settings → Developer settings → Personal access tokens**.
