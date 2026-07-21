import express from 'express';
import { Collection } from 'mongodb';
import { OAuth2Client } from 'google-auth-library';

interface Collections {
  users: Collection;
}

export default function oauthRoutes(collections: Collections, googleClientId: string, googleClientSecret: string) {
  const router = express.Router();

  // Generate OAuth URL for Python client (no auth required)
  router.get('/authorize', async (req, res) => {
    try {
      const redirectUri = req.query.redirect_uri as string;
      const state = req.query.state as string;
      
      if (!redirectUri || !state) {
        return res.status(400).json({ error: 'Missing redirect_uri or state' });
      }
      
      const OAuthClient = new OAuth2Client({
        clientId: googleClientId,
        clientSecret: googleClientSecret,
        redirectUri: redirectUri
      });
      
      const authUrl = OAuthClient.generateAuthUrl({
        access_type: 'offline',
        scope: [
          'https://www.googleapis.com/auth/userinfo.email',
          'https://www.googleapis.com/auth/userinfo.profile',
          'openid'
        ],
        state: state
      });
      
      res.json({ auth_url: authUrl });
    } catch (err) {
      console.error(err);
      res.status(500).send(err);
    }
  });

  // Exchange authorization code for tokens (no auth required).
  // Also handles grant_type=refresh_token so API clients can renew their
  // id_token without re-running the browser flow (Python-API issue #2).
  router.post('/token', async (req, res) => {
    try {
      const { code, redirect_uri, grant_type, refresh_token } = req.body;

      if (grant_type === 'refresh_token') {
        if (!refresh_token) {
          return res.status(400).json({ error: 'Missing refresh_token' });
        }

        const OAuthClient = new OAuth2Client({
          clientId: googleClientId,
          clientSecret: googleClientSecret
        });
        OAuthClient.setCredentials({ refresh_token });

        let credentials;
        try {
          ({ credentials } = await OAuthClient.refreshAccessToken());
        } catch (err) {
          // Revoked/expired refresh token: 401 tells the client to fall back
          // to the full browser login rather than retrying.
          return res.status(401).json({ error: 'invalid_grant' });
        }

        if (!credentials.id_token) {
          return res.status(401).json({ error: 'invalid_grant' });
        }

        // Look up the user so the client can keep its stored profile current.
        let profile = null;
        try {
          const ticket = await OAuthClient.verifyIdToken({
            idToken: credentials.id_token,
            audience: googleClientId
          });
          const sub = ticket.getPayload()?.sub;
          if (sub) {
            profile = await collections.users.findOne({ sub });
          }
        } catch (err) {
          console.error('Profile lookup after token refresh failed:', err);
        }

        return res.json({
          access_token: credentials.access_token,
          id_token: credentials.id_token,
          // Google usually omits refresh_token on refresh; echo the old one
          // so clients can always store what comes back.
          refresh_token: credentials.refresh_token || refresh_token,
          profile
        });
      }

      if (!code || !redirect_uri) {
        return res.status(400).json({ error: 'Missing code or redirect_uri' });
      }
      
      const OAuthClient = new OAuth2Client({
        clientId: googleClientId,
        clientSecret: googleClientSecret,
        redirectUri: redirect_uri
      });
      
      const { tokens } = await OAuthClient.getToken(code);
      OAuthClient.setCredentials(tokens);
      
      // Get user profile
      const userinfo = await OAuthClient.request({
        url: 'https://www.googleapis.com/oauth2/v3/userinfo'
      });
      
      // Register/login user in our database
      const profile = userinfo.data as any;
      const query = { sub: profile.sub };
      const update = { $set: profile };
      const options = { upsert: true, returnDocument: 'after' as const };
      const result = await collections.users.findOneAndUpdate(query, update, options);
      
      // Return tokens and user profile
      res.json({
        access_token: tokens.access_token,
        id_token: tokens.id_token,
        refresh_token: tokens.refresh_token,
        profile: result.value
      });
    } catch (err) {
      console.error(err);
      res.status(500).send(err);
    }
  });

  return router;
}