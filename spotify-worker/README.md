# Listen-along setup

This makes `majedalfaraj.github.io/listen/` show what you're playing on Spotify to friends with a password, and lets them press **Listen along** so their Spotify follows yours.

There are two pieces:

- **`listen/index.html`** is the page on the site. Friends type their password there, and it runs their side of the sync in their browser.
- **`spotify-worker/`** is a small Cloudflare Worker (free tier is plenty). It holds your Spotify login so it never shows up in the page, checks friend passwords, and reports what you're playing.

Everyone involved needs **Spotify Premium**. Spotify only lets apps control playback for Premium accounts, and since February 2026 a development-mode app's owner must have Premium too.

## 1. Create the Spotify app (about 3 minutes)

1. Go to <https://developer.spotify.com/dashboard> and click **Create app**.
2. Name it anything, for example "Listen along".
3. Add **both** Redirect URIs:
   - `https://majedalfaraj.github.io/listen/` (friends log in here)
   - `https://listen-along.<your-subdomain>.workers.dev/callback` (you log in here once; you'll know the exact URL after step 2, so you can come back and add it)
4. Tick **Web API**, save, and copy the **Client ID** and **Client secret**.
5. Under **User Management**, add each friend's name and the email on their Spotify account. Only people listed there can log in. Spotify caps this list at a few people in development mode.

## 2. Deploy the Worker (about 5 minutes)

You need Node installed and a free Cloudflare account.

```sh
cd spotify-worker
npx wrangler login
npx wrangler kv namespace create TOKENS        # paste the printed id into wrangler.toml
# also paste your Client ID into SPOTIFY_CLIENT_ID in wrangler.toml
npx wrangler secret put SPOTIFY_CLIENT_SECRET  # paste the Client secret
npx wrangler secret put FRIEND_PASSWORDS       # e.g. ali:blue-cactus-42,sara:quiet-otter-9
npx wrangler secret put SETUP_KEY              # any long random string
npx wrangler deploy                            # prints your Worker URL
```

Then connect your own Spotify account once, by opening this in your browser:

```
https://listen-along.<your-subdomain>.workers.dev/setup?key=<your SETUP_KEY>
```

Approve it, and you'll see "Connected".

## 3. Point the page at the Worker

In `listen/index.html`, set the two values in `CONFIG` near the top of the script:

```js
const CONFIG = {
  workerUrl: "https://listen-along.<your-subdomain>.workers.dev",
  clientId: "<your Client ID>",
};
```

Commit and push. The site redeploys on its own.

## Day to day: the admin page

Manage friends at **`majedalfaraj.github.io/listen/admin/`**. To turn it on, set an admin password once and redeploy:

```sh
cd spotify-worker
git pull
npx wrangler secret put ADMIN_PASSWORD   # your own password for the admin page
npx wrangler deploy
```

On the admin page you can:

- **Add a friend:** type a name, and either type a password or leave it blank to generate one. **Copy invite** copies the link and password to send them. Also add the email on their Spotify account in the Spotify dashboard under **Settings → User Management**, because Spotify has no API for that list.
- **Change a password:** save the same name again with a new password.
- **Remove a friend:** click **Remove**. Their password stops working within about 30 seconds. You can also remove them from User Management in Spotify.

The first time you save anything there, the friend list moves from the `FRIEND_PASSWORDS` secret into the Worker's storage, and the secret is no longer used.

**What friends do:** open `/listen/`, enter their password once, tap **Listen along**, and log in with Spotify the first time. After that, as long as the page is open and Spotify is open on one of their devices, it plays what you play, at the same spot, and follows skips, seeks and pauses within a few seconds.

## Limits worth knowing

- The friend's page has to stay open (a phone tab in the background may get paused by the OS).
- While you're playing, the page checks every 1.5 seconds (and right when your song should end), and re-seeks when they drift more than about 1.5 seconds. It's close, but not sample-exact.
- Phones pause background tabs, so on a phone the page works best left open on screen. On a computer, a background tab is fine.
- If the friend starts playing something else themselves, the page will switch them back to your song. They tap **Stop listening along** to break off.
- Spotify does not let apps create or share Jam links, so this syncs playback instead of joining a Jam. You both hear the same thing, but they can't add to your queue.
