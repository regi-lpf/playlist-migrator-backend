// server.js
import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import { env } from 'process';
import cors from 'cors';
import { google } from 'googleapis';
import bodyParser from 'body-parser';

dotenv.config();

const app = express();
const port = env.PORT;
const client_id = env.GOOGLE_CLIENT_ID;
const client_secret = env.GOOGLE_CLIENT_SECRET;
const redirect_uri = env.GOOGLE_REDIRECT_URI;

app.use(cors({
  origin: 'https://spotitube-psi.vercel.app', 
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
};


app.get('/auth/youtube', (req, res) => {
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: ['https://www.googleapis.com/auth/youtube', 'https://www.googleapis.com/auth/youtube.force-ssl'],
    });
    res.redirect(url);
});


app.get('/oauth2callback', async (req, res) => {
    const { code } = req.query;  // Extract the code from the query string
    const { tokens } = await oauth2Client.getToken(code);  // Exchange the code for tokens
    oauth2Client.setCredentials(tokens);  // Store the tokens in the OAuth client
    
    const token = tokens.access_token;  // Extract the access token
    res.redirect(`https://spotitube-psi.vercel.app/youtube-auth-success.html?token=${token}`);  // Redirect to the success page with the token
});


app.get('/check-auth', (req, res) => {
  if (!oauth2Client.credentials) return res.sendStatus(401);
  res.sendStatus(200);
});


// Utility to fetch Spotify access token
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
  
  // Utility to get all tracks from a Spotify playlist
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
    if (!oauth2Client.credentials) return res.status(401).send('Not authenticated with YouTube');
  
    const { spotifyUrl, youtubeUrl } = req.body;
    if (!spotifyUrl) return res.status(400).json({ error: 'Spotify URL is required' });
  
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
  
      const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
  
      if (!youtubeId) {
        const newPlaylist = await youtube.playlists.insert({
          part: 'snippet,status',
          requestBody: {
            snippet: { title: 'Migrada do Spotify', description: 'Importada automaticamente' },
            status: { privacyStatus: 'private' }
          }
        });
        youtubeId = newPlaylist.data.id;
      }
  
      for (const t of tracks) {
        const q = `${t.artist} ${t.track}`;
        const ytRes = await youtube.search.list({ part: 'snippet', q, maxResults: 1 });
        const videoId = ytRes.data.items[0]?.id?.videoId;

        if (videoId) {
            await insertVideo(youtube, youtubeId, videoId);
            await delay(300);
        }
      }
  
      res.json({ youtubePlaylistUrl: `https://www.youtube.com/playlist?list=${youtubeId}` });
    } catch (error) {
      console.error(error);
      res.status(500).send("Couldn't migrate playlist");
    }
  });
  
  async function insertVideo(youtube, playlistId, videoId, retries = 1) {
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
