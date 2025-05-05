import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import { env } from 'process';
import cors from 'cors';
import { google } from 'googleapis';
import bodyParser from 'body-parser';
import { search } from '@regi_lpf/s2y-query';

dotenv.config();

const app = express();
const port = env.PORT;
const client_id = env.GOOGLE_CLIENT_ID;
const client_secret = env.GOOGLE_CLIENT_SECRET;
const redirect_uri = env.GOOGLE_REDIRECT_URI;

app.use(cors({
  origin: 'https://regilpf-s2y.vercel.app',
  credentials: true
}));

app.use(bodyParser.json());

const oauth2Client = new google.auth.OAuth2(
  client_id,
  client_secret,
  redirect_uri
);

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Simple in-memory queue
const userQueues = new Map();

app.get('/auth/youtube', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/youtube', 'https://www.googleapis.com/auth/youtube.force-ssl'],
    prompt: 'consent'
  });
  res.redirect(url);
});

app.get('/oauth2callback', async (req, res) => {
  const { code } = req.query;
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  const { access_token, refresh_token } = tokens;
  res.redirect(`https://regilpf-s2y.vercel.app/youtube-auth-success.html?token=${access_token}&refresh=${refresh_token}`);
  
  res.cookie('accessToken', accessToken, {
    httpOnly: true,
    secure: true,             // REQUIRED for SameSite=None
    sameSite: 'None',         // REQUIRED for cross-site cookies
    maxAge: 1000 * 60 * 60
  });

  res.cookie('refreshToken', refreshToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'None',
    maxAge: 1000 * 60 * 60 * 24 * 30
  });  
});

app.get('/check-auth', (req, res) => {
  if (!oauth2Client.credentials) return res.sendStatus(401);
  res.sendStatus(200);
});

async function getSpotifyToken(clientId, clientSecret) {
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Failed to fetch Spotify token');
  return data.access_token;
}

async function getSpotifyPlaylistName(token, playlistId) {
  const res = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Failed to fetch playlist details');
  return data.name.toString();
}

async function getSpotifyTracks(token, playlistId) {
  let url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks`;
  let tracks = [];

  while (url) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'Failed to fetch tracks');
    tracks = tracks.concat(data.items);
    url = data.next;
  }

  return tracks.map(item => ({
    track: item.track.name,
    artist: item.track.artists[0]?.name
  }));
}

app.post('/migrate/spotify-to-youtube', async (req, res) => {
  const { spotifyUrl, youtubeUrl, userAccessToken, userRefreshToken } = req.body;

  if (!spotifyUrl || !userAccessToken || !userRefreshToken) {
    return res.status(400).json({ error: 'Spotify URL and YouTube tokens are required' });
  }

  // Get user ID from YouTube API
  const userOAuth = new google.auth.OAuth2(client_id, client_secret, redirect_uri);
  userOAuth.setCredentials({
    access_token: userAccessToken,
    refresh_token: userRefreshToken
  });

  const youtube = google.youtube({ version: 'v3', auth: userOAuth });

  let userId;
  try {
    const userResponse = await youtube.channels.list({
      part: 'id',
      mine: true
    });

    userId = userResponse.data.items?.[0]?.id;
    if (!userId) {
      throw new Error('Failed to retrieve user ID from YouTube');
    }
  } catch (err) {
    return res.status(500).json({ error: 'Could not retrieve user ID', details: err.message });
  }

  if (userQueues.has(userId) && userQueues.get(userId).pending) {
    return res.status(429).json({ error: 'Migration already in progress for this user' });
  }

  userQueues.set(userId, { pending: true });

  const matchSpotify = spotifyUrl.match(/playlist\/([a-zA-Z0-9]+)/);
  if (!matchSpotify) return res.status(400).json({ error: 'Invalid Spotify URL' });
  const playlistId = matchSpotify[1];

  let youtubeId = null;
  if (youtubeUrl) {
    const matchYoutube = youtubeUrl.match(/list=([a-zA-Z0-9_-]+)/);
    if (!matchYoutube) return res.status(400).json({ error: 'Invalid YouTube playlist URL' });
    youtubeId = matchYoutube[1];
  }

  try {
    const spotifyToken = await getSpotifyToken(env.CLIENT_ID, env.CLIENT_SECRET);
    const tracks = await getSpotifyTracks(spotifyToken, playlistId);

    const userOAuth = new google.auth.OAuth2(client_id, client_secret, redirect_uri);
    userOAuth.setCredentials({
      access_token: userAccessToken,
      refresh_token: userRefreshToken
    });

    const youtube = google.youtube({ version: 'v3', auth: userOAuth });

    if (!youtubeId) {
      const newPlaylistName = await getSpotifyPlaylistName(spotifyToken, playlistId);
      const newPlaylist = await youtube.playlists.insert({
        part: 'snippet,status',
        requestBody: {
          snippet: { title: newPlaylistName, description: 'Migrated with regi_lpf\'s S2Y' },
          status: { privacyStatus: 'private' }
        }
      });
      youtubeId = newPlaylist.data.id;
    }

    for (const t of tracks) {
      const q = `${t.artist} ${t.track}`;
      const ytRes = await search(q);
      const videoId = ytRes[0];

      if (videoId) {
        await insertVideo(youtube, youtubeId, videoId);
        await delay(300);
      }
    }

    res.json({ youtubePlaylistUrl: `https://www.youtube.com/playlist?list=${youtubeId}` });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: error.status, error: error.message || error.errors?.[0]?.message });
  } finally {
    userQueues.set(userId, { pending: false });
  }
});

async function insertVideo(youtube, playlistId, videoId, retries = 5) {
  try {
    await youtube.playlistItems.insert({
      part: 'snippet',
      requestBody: {
        snippet: {
          playlistId,
          resourceId: {
            kind: 'youtube#video',
            videoId
          }
        }
      }
    });
  } catch (error) {
    if (retries > 0 && error.code === 409) {
      console.warn(`409 error on video ${videoId}, retrying in 1s...`);
      await delay(1000);
      return insertVideo(youtube, playlistId, videoId, retries - 1);
    }
    throw error;
  }
}

app.listen(port, () => {
  console.log(`Servidor rodando em ${port}`);
});
