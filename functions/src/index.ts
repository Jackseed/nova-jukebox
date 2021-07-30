/* eslint-disable */
const functions = require('firebase-functions');
const axios = require('axios').default;
const axiosRetry = require('axios-retry');
axiosRetry(axios, {
  retries: 3,
});
const admin = require('firebase-admin');
admin.initializeApp();

/////////////////////// HEADERS FOR SPOTIFY API ///////////////////////
// refresh access token
async function getSpotifyAuthHeaders(): Promise<Object> {
  // encode secrets
  const secret = Buffer.from(
    `${functions.config().spotify.clientid}:${
      functions.config().spotify.clientsecret
    }`
  ).toString('base64');

  // use a refresh token manually get beforehand
  const params = new URLSearchParams();
  params.append('grant_type', 'refresh_token');
  params.append('refresh_token', functions.config().spotify.refreshtoken);

  const config = {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${secret}`,
    },
  };

  let token = '';
  // request a fresh access token
  await axios
    .post('https://accounts.spotify.com/api/token', params, config)
    .then(
      (response: any) => {
        token = response.data.access_token;
      },
      (error: any) => {
        console.log('error: ', error);
      }
    );

  // build api call header
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };

  return headers;
}

/////////////////////// GET PLAYLIST TRACKS ///////////////////////
exports.getPlaylistTracks = functions
  .runWith({
    timeoutSeconds: 500,
  })
  .https.onRequest(async (req: any, res: any) => {
    const headers = await getSpotifyAuthHeaders();
    const playlistId = req.body.playlistId;
    let playlist: any;

    // get the playlist to know total track number
    await axios({
      headers,
      url: `https://api.spotify.com/v1/playlists/${playlistId}`,
    })
      .then((response: any) => {
        playlist = response.data;
      })
      .catch((error: any) => console.log(error));

    let allPlaylistTracks: any[] = [];
    const playlistTracksLimit = 100;
    const requestArray: any[] = [];
    // minimize the calls needed to what will be saved, -1 is here to compensate the array starting to 0
    const totalTracksCalled: number =
      req.body.start - req.body.end
        ? Math.min(playlist.tracks.total, req.body.end - req.body.start) - 1
        : playlist.tracks.total;

    if (playlist) {
      // create all the requests to get the playlist tracks within API limits
      for (
        let i = 0;
        // check if it's the last tracks of the array, if it is then adds 1 to get what's left
        totalTracksCalled % playlistTracksLimit == 0
          ? i <= Math.floor(totalTracksCalled / playlistTracksLimit)
          : i <= Math.floor(totalTracksCalled / playlistTracksLimit) + 1;
        i++
      ) {
        const offset = i * playlistTracksLimit;

        const url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks`;
        const queryParam = `?limit=${playlistTracksLimit}&offset=${offset}`;

        const request = axios({
          headers,
          url: `${url + queryParam}`,
          method: 'GET',
        });
        requestArray.push(request);
      }
    }

    // send all the requests
    await Promise.all(
      requestArray.map(async (request, index) => {
        return await request
          .then((response: any) => {
            const playlistTracks: any = response.data;
            const tracks: any[] = [];
            // extract needed track info
            playlistTracks.items.map((item: any) => {
              tracks.push({
                added_at: item.added_at ? item.added_at : '',
                added_at_day: item.added_at
                  ? new Date(item.added_at).getDay()
                  : null,
                added_at_hours: item.added_at
                  ? new Date(item.added_at).getHours()
                  : null,
                name: item.track.name ? item.track.name : '',
                uri: item.track.uri ? item.track.uri : '',
                spotifyId: item.track.id ? item.track.id : '',
                duration_ms: item.track.duration_ms
                  ? item.track.duration_ms
                  : null,
                artist: item.track.artists[0].name
                  ? item.track.artists[0].name
                  : '',
                album: item.track.album.name ? item.track.album.name : '',
                image: item.track.album.images[0].url
                  ? item.track.album.images[0].url
                  : '',
                nova_channel: req.body.nova,
              });
            });

            allPlaylistTracks = allPlaylistTracks.concat(tracks);

            console.log(`loading batch ${index}`);
          })
          .catch((err: any) => console.log('Something broke!', err));
      })
    )
      .then(() => {
        console.log('All batch loaded!');
      })
      .catch((err) => console.log('something went wrong.. ', err));

    if (req.body.start - req.body.end)
      allPlaylistTracks = allPlaylistTracks.slice(req.body.start, req.body.end);
    // save tracks on firestore
    await axios({
      headers: {
        'Content-Type': 'application/json',
      },
      url: 'https://us-central1-nova-jukebox.cloudfunctions.net/saveTracks',
      data: {
        tracks: allPlaylistTracks,
      },
      method: 'POST',
    }).catch((err: any) => console.log('error: ', err));

    res.json({
      result: `Tracks successfully saved from playlistId, total tracks: ${allPlaylistTracks.length}.`,
    });

    return res;
  });

exports.saveTracks = functions
  .runWith({
    timeoutSeconds: 500,
  })
  .https.onRequest(async (req: any, res: any) => {
    const tracks = req.body.tracks;
    const firebaseWriteLimit = 500;
    console.log('total tracks saving: ', tracks.length);
    for (let i = 0; i <= Math.floor(tracks.length / firebaseWriteLimit); i++) {
      const bactchTracks = tracks.slice(
        firebaseWriteLimit * i,
        firebaseWriteLimit * (i + 1)
      );
      const batch = admin.firestore().batch();
      for (const track of bactchTracks) {
        if (track) {
          const ref = admin.firestore().collection('tracks').doc();
          batch.set(ref, track, { merge: true });
        }
      }

      await batch
        .commit()
        .then((_: any) => console.log(`batch of ${i} saved`))
        .catch((error: any) => console.log(error));
    }
    res.json({
      result: `Tracks successfully saved on Firestore, total tracks: ${tracks.length}.`,
    });

    return res;
  });

////////////////// REQUEST SPOTIFY REFRESH OR ACCESS TOKENS //////////////////
exports.getSpotifyToken = functions
  .runWith({
    timeoutSeconds: 500,
  })
  .https.onCall(async (data: any, context: any) => {
    const secret = Buffer.from(
      `${functions.config().spotify.clientid}:${
        functions.config().spotify.clientsecret
      }`
    ).toString('base64');

    const params = new URLSearchParams();
    // same function for either getting an access & refresh tokens (through code, tokenType access) or an access token through refresh token
    if (data.tokenType === 'access') {
      params.append('grant_type', 'authorization_code');
      params.append('code', data.code);
      params.append('redirect_uri', 'http://localhost:4200');
    } else {
      params.append('grant_type', 'refresh_token');
      params.append('refresh_token', data.refreshToken);
    }

    const config = {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${secret}`,
      },
    };

    let token = '';
    let refresh_token = '';

    await axios
      .post('https://accounts.spotify.com/api/token', params, config)
      .then(
        (response: any) => {
          token = response.data.access_token;
          if (data.tokenType === 'access') {
            refresh_token = response.data.refresh_token;
            console.log(refresh_token);
          }
        },
        (error: any) => {
          console.log('error: ', error);
        }
      );

    // save tokens on db
    await axios({
      headers: {
        'Content-Type': 'application/json',
      },
      url: 'https://us-central1-nova-jukebox.cloudfunctions.net/saveToken',
      data: {
        token,
        refreshToken: refresh_token,
        tokenType: data.tokenType,
        userId: data.userId,
      },
      method: 'POST',
    }).catch((err: any) => console.log('error: ', err));

    return { token, refresh_token };
  });

exports.saveToken = functions
  .runWith({
    timeoutSeconds: 60,
  })
  .https.onRequest(async (req: any, res: any) => {
    const accessToken = req.body.token;
    if (accessToken) {
      let tokens: { access: string; addedTime: Object; refresh?: string } = {
        access: accessToken,
        addedTime: admin.firestore.FieldValue.serverTimestamp(),
      };
      // add refresh token only when requesting an access token for the first time
      if (req.body.tokenType === 'access')
        tokens = { ...tokens, refresh: req.body.refreshToken };

      await admin.firestore().collection('users').doc(req.body.userId).set(
        {
          tokens,
        },
        { merge: true }
      );

      res.json({ result: `Access token successfully added: ${accessToken}.` });
    } else {
      res.json({ result: `Empty token.` });
    }
  });
