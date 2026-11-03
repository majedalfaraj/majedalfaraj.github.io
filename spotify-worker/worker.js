// Listen-along Worker.
// Holds Majed's Spotify refresh token and returns what he is playing,
// but only to someone who sends a valid friend password.

const SPOTIFY_ACCOUNTS = "https://accounts.spotify.com";
const SPOTIFY_API = "https://api.spotify.com/v1";
const OWNER_SCOPES = "user-read-currently-playing user-read-playback-state";
const CACHE_MS = 2000; // share one Spotify call between friends polling at the same time

let accessToken = null;   // { token, expiresAt }
let cached = null;        // { body, at }

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      if (url.pathname === "/setup") return setup(url, env);
      if (url.pathname === "/callback") return callback(url, env);
      if (url.pathname === "/now-playing") return await nowPlaying(request, env, cors);
      return new Response("Not found", { status: 404 });
    } catch (err) {
      return json({ error: "server", message: String(err && err.message || err) }, 500, cors);
    }
  },
};

// ---- one-time owner setup -------------------------------------------------

function redirectUri(url) {
  return `${url.origin}/callback`;
}

function setup(url, env) {
  if (!env.SETUP_KEY || url.searchParams.get("key") !== env.SETUP_KEY) {
    return new Response("Wrong or missing setup key.", { status: 403 });
  }
  const auth = new URL(`${SPOTIFY_ACCOUNTS}/authorize`);
  auth.search = new URLSearchParams({
    response_type: "code",
    client_id: env.SPOTIFY_CLIENT_ID,
    scope: OWNER_SCOPES,
    redirect_uri: redirectUri(url),
    state: env.SETUP_KEY,
  });
  return Response.redirect(auth.toString(), 302);
}

async function callback(url, env) {
  if (url.searchParams.get("state") !== env.SETUP_KEY) {
    return new Response("Bad state.", { status: 403 });
  }
  const code = url.searchParams.get("code");
  if (!code) return new Response(`Spotify said: ${url.searchParams.get("error") || "no code"}`, { status: 400 });

  const tokens = await tokenRequest(env, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(url),
  });
  await env.TOKENS.put("refresh_token", tokens.refresh_token);
  accessToken = { token: tokens.access_token, expiresAt: Date.now() + (tokens.expires_in - 60) * 1000 };
  return new Response("Connected. Your friends can now see what you're playing. You can close this tab.", {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

// ---- friend endpoint -------------------------------------------------------

async function nowPlaying(request, env, cors) {
  const friend = checkPassword(request, env);
  if (!friend) return json({ error: "password" }, 401, cors);

  if (cached && Date.now() - cached.at < CACHE_MS) {
    return json({ ...cached.body, friend, server_time: Date.now() }, 200, cors);
  }

  let res = await spotifyGet(env, "/me/player/currently-playing?additional_types=track,episode");
  if (res.status === 401) {
    accessToken = null;
    res = await spotifyGet(env, "/me/player/currently-playing?additional_types=track,episode");
  }

  let body;
  if (res.status === 204) {
    body = { playing: false };
  } else if (res.ok) {
    const data = await res.json();
    body = shape(data);
  } else if (res.status === 429) {
    return json({ error: "rate_limited", retry_after: Number(res.headers.get("retry-after") || 5) }, 503, cors);
  } else {
    return json({ error: "spotify", status: res.status }, 502, cors);
  }

  cached = { body, at: Date.now() };
  return json({ ...body, friend, server_time: Date.now() }, 200, cors);
}

function shape(data) {
  const item = data && data.item;
  if (!item) return { playing: false };
  const isEpisode = item.type === "episode";
  const images = isEpisode ? item.images : item.album && item.album.images;
  return {
    playing: !!data.is_playing,
    progress_ms: data.progress_ms || 0,
    track: {
      uri: item.uri,
      name: item.name,
      artists: isEpisode ? [item.show && item.show.name].filter(Boolean) : (item.artists || []).map(a => a.name),
      album: isEpisode ? "" : (item.album && item.album.name) || "",
      image: images && images.length ? images[0].url : null,
      duration_ms: item.duration_ms,
      url: item.external_urls && item.external_urls.spotify,
    },
  };
}

function checkPassword(request, env) {
  const header = request.headers.get("authorization") || "";
  const given = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!given) return null;
  for (const pair of (env.FRIEND_PASSWORDS || "").split(",")) {
    const i = pair.indexOf(":");
    if (i < 1) continue;
    const name = pair.slice(0, i).trim();
    const pass = pair.slice(i + 1).trim();
    if (pass && safeEqual(given, pass)) return name;
  }
  return null;
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---- Spotify helpers -------------------------------------------------------

async function spotifyGet(env, path) {
  const token = await getAccessToken(env);
  return fetch(`${SPOTIFY_API}${path}`, { headers: { authorization: `Bearer ${token}` } });
}

async function getAccessToken(env) {
  if (accessToken && Date.now() < accessToken.expiresAt) return accessToken.token;
  const refresh = await env.TOKENS.get("refresh_token");
  if (!refresh) throw new Error("Spotify isn't connected yet. Visit /setup?key=YOUR_SETUP_KEY on this Worker.");
  const tokens = await tokenRequest(env, { grant_type: "refresh_token", refresh_token: refresh });
  if (tokens.refresh_token && tokens.refresh_token !== refresh) {
    await env.TOKENS.put("refresh_token", tokens.refresh_token);
  }
  accessToken = { token: tokens.access_token, expiresAt: Date.now() + (tokens.expires_in - 60) * 1000 };
  return accessToken.token;
}

async function tokenRequest(env, params) {
  const res = await fetch(`${SPOTIFY_ACCOUNTS}/api/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: "Basic " + btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`),
    },
    body: new URLSearchParams(params),
  });
  if (!res.ok) throw new Error(`Spotify token request failed (${res.status}): ${await res.text()}`);
  return res.json();
}

// ---- HTTP helpers ----------------------------------------------------------

function corsHeaders(request, env) {
  const origin = request.headers.get("origin") || "";
  const allowed = (env.ALLOWED_ORIGIN || "").split(",").map(s => s.trim());
  return {
    "access-control-allow-origin": allowed.includes(origin) ? origin : allowed[0] || "",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "authorization",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "content-type": "application/json", "cache-control": "no-store" },
  });
}
